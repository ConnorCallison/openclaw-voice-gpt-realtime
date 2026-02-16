import { type Server } from "node:http";
import { createServer } from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import { validateRequest } from "twilio/lib/webhooks/webhooks.js";
import { randomBytes } from "node:crypto";
import type { PluginConfig } from "./config.ts";
import type { CallManager } from "./call-manager.ts";
import type { TwilioClient } from "./twilio-client.ts";
import { RealtimeBridge } from "./realtime-bridge.ts";
import { checkStatus } from "./status.ts";
import type { CallContext } from "./prompts.ts";

const MAX_BODY_SIZE = 64 * 1024; // 64KB — Twilio payloads are typically <10KB

export class VoiceServer {
  private config: PluginConfig;
  private callManager: CallManager;
  private twilioClient: TwilioClient;
  private httpServer: Server | null = null;
  private wss: WebSocketServer | null = null;
  private bridges = new Map<string, RealtimeBridge>();
  private listening = false;
  private agentName = "";
  // Pending call contexts awaiting Twilio stream connection
  private pendingCallContexts = new Map<string, CallContext>();
  // Per-call secret tokens for WebSocket authentication
  private callTokens = new Map<string, string>();

  constructor(config: PluginConfig, callManager: CallManager, twilioClient: TwilioClient) {
    this.config = config;
    this.callManager = callManager;
    this.twilioClient = twilioClient;
  }

  setAgentName(name: string): void {
    this.agentName = name;
  }

  async start(): Promise<void> {
    return new Promise((resolve) => {
      this.httpServer = createServer((req, res) => {
        this.handleHttp(req, res);
      });

      this.wss = new WebSocketServer({ noServer: true });

      this.httpServer.on("upgrade", (req, socket, head) => {
        const url = new URL(req.url || "/", `http://${req.headers.host}`);

        if (url.pathname === "/voice/realtime-stream") {
          // Validate per-call token
          const callId = url.searchParams.get("callId") || "";
          const token = url.searchParams.get("token") || "";
          const expectedToken = this.callTokens.get(callId);

          if (!expectedToken || token !== expectedToken) {
            socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
            socket.destroy();
            return;
          }

          this.wss!.handleUpgrade(req, socket, head, (ws) => {
            this.handleWebSocket(ws, url);
          });
        } else {
          socket.destroy();
        }
      });

      this.httpServer.listen(this.config.server.port, this.config.server.bind, () => {
        this.listening = true;
        console.log(
          `[openclaw-voice-gpt-realtime] Server listening on ${this.config.server.bind}:${this.config.server.port}`
        );
        resolve();
      });
    });
  }

  async stop(): Promise<void> {
    this.listening = false;

    // Close all bridges
    for (const bridge of this.bridges.values()) {
      await bridge.close();
    }
    this.bridges.clear();

    // Close WebSocket server
    this.wss?.close();

    // Close HTTP server
    return new Promise((resolve) => {
      if (this.httpServer) {
        this.httpServer.close(() => resolve());
      } else {
        resolve();
      }
    });
  }

  isListening(): boolean {
    return this.listening;
  }

  setCallContext(callId: string, context: CallContext): void {
    this.pendingCallContexts.set(callId, context);
    // Generate a per-call secret token for WebSocket authentication
    const token = randomBytes(32).toString("hex");
    this.callTokens.set(callId, token);
  }

  getCallToken(callId: string): string | undefined {
    return this.callTokens.get(callId);
  }

  private handleHttp(req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse): void {
    const url = new URL(req.url || "/", `http://${req.headers.host}`);

    // Parse body for POST requests
    if (req.method === "POST") {
      let body = "";
      let bodySize = 0;
      req.on("data", (chunk: Buffer | string) => {
        bodySize += typeof chunk === "string" ? chunk.length : chunk.byteLength;
        if (bodySize > MAX_BODY_SIZE) {
          res.writeHead(413);
          res.end("Payload too large");
          req.destroy();
          return;
        }
        body += chunk;
      });
      req.on("end", () => {
        if (bodySize > MAX_BODY_SIZE) return; // already rejected

        if (this.requiresTwilioSignature(url.pathname)) {
          const twilioSignature = req.headers["x-twilio-signature"] as string | undefined;
          if (!twilioSignature) {
            res.writeHead(403);
            res.end("Missing Twilio signature");
            return;
          }

          const fullUrl = new URL(`${url.pathname}${url.search}`, this.config.publicUrl).toString();
          const bodyParams: Record<string, string> = {};
          const parsed = new URLSearchParams(body);
          for (const [k, v] of parsed) bodyParams[k] = v;

          if (!validateRequest(this.config.twilio.authToken, twilioSignature, fullUrl, bodyParams)) {
            res.writeHead(403);
            res.end("Invalid Twilio signature");
            return;
          }
        }

        const params = new URLSearchParams(body);
        const queryParams = url.searchParams;
        // Merge query and body params
        for (const [k, v] of queryParams) params.set(k, v);

        this.routePost(url.pathname, params, res);
      });
      return;
    }

    if (req.method === "GET") {
      this.routeGet(url.pathname, res);
      return;
    }

    res.writeHead(405);
    res.end("Method not allowed");
  }

  private routePost(path: string, params: URLSearchParams, res: import("node:http").ServerResponse): void {
    switch (path) {
      case "/voice/answer":
        this.handleVoiceAnswer(params, res);
        break;
      case "/voice/status":
        this.handleVoiceStatus(params, res);
        break;
      case "/voice/amd":
        this.handleAmd(params, res);
        break;
      default:
        res.writeHead(404);
        res.end("Not found");
    }
  }

  private requiresTwilioSignature(path: string): boolean {
    return path === "/voice/answer" || path === "/voice/status" || path === "/voice/amd";
  }

  private async routeGet(path: string, res: import("node:http").ServerResponse): Promise<void> {
    switch (path) {
      case "/voice/status": {
        const status = await checkStatus(this.config, this.listening);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(status, null, 2));
        break;
      }
      case "/voice/answer":
        // Return a basic TwiML for GET requests (health check)
        res.writeHead(200, { "Content-Type": "application/xml" });
        res.end('<?xml version="1.0" encoding="UTF-8"?><Response><Say>OpenClaw voice server is running.</Say></Response>');
        break;
      default:
        res.writeHead(404);
        res.end("Not found");
    }
  }

  private handleVoiceAnswer(params: URLSearchParams, res: import("node:http").ServerResponse): void {
    const direction = params.get("Direction");
    const callSid = params.get("CallSid");
    const from = params.get("From") || "";
    const to = params.get("To") || "";

    // Check if this is an inbound call (no callId in query = not initiated by us)
    const queryCallId = params.get("callId");

    if (!queryCallId && direction === "inbound") {
      // Inbound call — check policy
      if (!this.shouldAcceptInbound(from)) {
        res.writeHead(200, { "Content-Type": "application/xml" });
        res.end('<?xml version="1.0" encoding="UTF-8"?><Response><Hangup/></Response>');
        return;
      }

      // Enforce concurrent call limit
      if (this.callManager.getActiveCalls().length >= this.config.calls.maxConcurrent) {
        res.writeHead(200, { "Content-Type": "application/xml" });
        res.end('<?xml version="1.0" encoding="UTF-8"?><Response><Say>Sorry, all lines are busy. Please try again later.</Say><Hangup/></Response>');
        return;
      }

      // Accept inbound call
      const callId = `inbound_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

      this.callManager.createCall(callId, to, from, "Inbound call", "inbound");
      if (callSid) {
        this.callManager.setCallSid(callId, callSid);
      }
      this.callManager.updateStatus(callId, "in-progress");

      // Set inbound call context (also generates a call token)
      this.setCallContext(callId, {
        task: "Inbound call — answer and help the caller with whatever they need.",
        direction: "inbound",
        agentName: this.agentName,
        greeting: this.config.inbound.greeting,
        inboundSystemPrompt: this.config.inbound.systemPrompt,
      });

      const token = this.callTokens.get(callId)!;
      const wsUrl = `${this.config.publicUrl.replace(/^http/, "ws")}/voice/realtime-stream?callId=${encodeURIComponent(callId)}&token=${token}`;

      const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <Stream url="${wsUrl}">
      <Parameter name="callId" value="${callId}" />
    </Stream>
  </Connect>
</Response>`;

      res.writeHead(200, { "Content-Type": "application/xml" });
      res.end(twiml);
      return;
    }

    // Outbound call (initiated by us)
    const callId = queryCallId || "unknown";

    if (callSid) {
      this.callManager.setCallSid(callId, callSid);
      this.callManager.updateStatus(callId, "in-progress");
    }

    // Return TwiML to connect Twilio to our WebSocket (include per-call token)
    const token = this.callTokens.get(callId) || "";
    const wsUrl = `${this.config.publicUrl.replace(/^http/, "ws")}/voice/realtime-stream?callId=${encodeURIComponent(callId)}&token=${token}`;

    const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <Stream url="${wsUrl}">
      <Parameter name="callId" value="${callId}" />
    </Stream>
  </Connect>
</Response>`;

    res.writeHead(200, { "Content-Type": "application/xml" });
    res.end(twiml);
  }

  private shouldAcceptInbound(from: string): boolean {
    const { enabled, policy, allowFrom } = this.config.inbound;

    if (!enabled || policy === "disabled") return false;
    if (policy === "open") return true;
    if (policy === "allowlist") {
      // Normalize: strip spaces, ensure +prefix
      const normalized = from.replace(/\s/g, "");
      return allowFrom.some((allowed) => {
        const normalizedAllowed = allowed.replace(/\s/g, "");
        return normalized === normalizedAllowed;
      });
    }
    return false;
  }

  private handleVoiceStatus(params: URLSearchParams, res: import("node:http").ServerResponse): void {
    const callId = params.get("callId");
    const callSid = params.get("CallSid");
    const callStatus = params.get("CallStatus");

    if (callId && callStatus) {
      const statusMap: Record<string, "ringing" | "in-progress" | "completed" | "failed" | "no-answer" | "busy"> = {
        ringing: "ringing",
        "in-progress": "in-progress",
        completed: "completed",
        failed: "failed",
        "no-answer": "no-answer",
        busy: "busy",
        canceled: "failed",
      };

      const mappedStatus = statusMap[callStatus];
      if (mappedStatus) {
        if (callSid) this.callManager.setCallSid(callId, callSid);
        this.callManager.updateStatus(callId, mappedStatus);

        // Clean up bridge on terminal states
        if (["completed", "failed", "no-answer", "busy"].includes(mappedStatus)) {
          const bridge = this.bridges.get(callId);
          if (bridge) {
            bridge.close();
            this.bridges.delete(callId);
          }
          this.pendingCallContexts.delete(callId);
          this.callTokens.delete(callId);
        }
      }
    }

    res.writeHead(200);
    res.end();
  }

  private handleAmd(params: URLSearchParams, res: import("node:http").ServerResponse): void {
    const callId = params.get("callId");
    const answeredBy = params.get("AnsweredBy");

    if (callId && answeredBy) {
      this.callManager.setAmdResult(callId, answeredBy);

      // If it's a machine/voicemail, the model's prompt will handle it naturally
      // (the system prompt instructs to leave a brief message and hang up)
    }

    res.writeHead(200);
    res.end();
  }

  private handleWebSocket(ws: WebSocket, url: URL): void {
    const callId = url.searchParams.get("callId") || "unknown";
    const callContext = this.pendingCallContexts.get(callId) || {
      task: "General phone call — ask what they need or answer their questions.",
      direction: "outbound" as const,
    };

    console.log(`[openclaw-voice-gpt-realtime] WebSocket connected for call ${callId}`);

    const bridge = new RealtimeBridge(
      ws,
      this.config,
      this.callManager,
      this.twilioClient,
      callId,
      callContext
    );

    this.bridges.set(callId, bridge);

    ws.on("close", () => {
      this.bridges.delete(callId);
      this.pendingCallContexts.delete(callId);
      this.callTokens.delete(callId);
    });
  }
}
