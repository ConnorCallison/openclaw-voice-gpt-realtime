/**
 * openclaw-voice-gpt-realtime
 *
 * Ultra-low-latency AI phone calls powered by OpenAI's Realtime API.
 * Replaces the multi-step STT → LLM → TTS pipeline with a single
 * speech-to-speech model for ~200-300ms response latency.
 */

import { Type, type Static } from "@sinclair/typebox";
import { parseConfig, type PluginConfig } from "./src/config.ts";
import { CallManager } from "./src/call-manager.ts";
import { TwilioClient } from "./src/twilio-client.ts";
import { VoiceServer } from "./src/server.ts";
import { checkStatus } from "./src/status.ts";
import type { CallContext } from "./src/prompts.ts";

const MakePhoneCallParams = Type.Object({
  to: Type.String({ description: "Phone number to call in E.164 format (e.g. +14155551234)" }),
  task: Type.String({
    description:
      "Plain English description of what to accomplish on this call. Be specific — include names, dates, " +
      "times, quantities, questions to ask, or any details the caller needs. " +
      "Examples: 'Ask what their hours are tonight', 'Make a reservation for 4 people on Friday at 7pm " +
      "under the name Connor', 'Ask if they have the iPhone 16 Pro in stock and what the price is', " +
      "'Schedule a haircut appointment for Saturday morning'",
  }),
});

type MakePhoneCallParamsType = Static<typeof MakePhoneCallParams>;

const voiceRealtimeConfigSchema = {
  parse(value: unknown) {
    const raw = value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
    return parseConfig(raw);
  },
  uiHints: {
    "twilio.accountSid": { label: "Twilio Account SID" },
    "twilio.authToken": { label: "Twilio Auth Token", sensitive: true },
    fromNumber: { label: "From Phone Number", placeholder: "+17077024785" },
    "openai.apiKey": { label: "OpenAI API Key", sensitive: true },
    "openai.model": { label: "Realtime Model" },
    "openai.voice": { label: "AI Voice" },
    "vad.type": { label: "VAD Type", advanced: true },
    "vad.eagerness": { label: "VAD Eagerness", advanced: true },
    publicUrl: { label: "Public Webhook URL", placeholder: "https://your-domain.com" },
    "server.port": { label: "Server Port", advanced: true },
    "server.bind": { label: "Server Bind Address", advanced: true },
    "calls.maxDurationSeconds": { label: "Max Call Duration (sec)", advanced: true },
    "calls.timeoutSeconds": { label: "Ring Timeout (sec)", advanced: true },
    "calls.enableAmd": { label: "Answering Machine Detection", advanced: true },
    "inbound.enabled": { label: "Enable Inbound Calls" },
    "inbound.policy": { label: "Inbound Policy" },
    "inbound.allowFrom": { label: "Allowed Callers (E.164)", advanced: true },
    "inbound.greeting": { label: "Inbound Greeting" },
    "inbound.systemPrompt": { label: "Inbound System Prompt", advanced: true },
    debug: { label: "Debug Mode" },
  },
};

let config: PluginConfig;
let callManager: CallManager;
let twilioClient: TwilioClient;
let server: VoiceServer;

const voiceRealtimePlugin = {
  id: "openclaw-voice-gpt-realtime",
  name: "Voice Calls (OpenAI Realtime)",
  description:
    "Ultra-low-latency AI phone calls powered by OpenAI's Realtime API. " +
    "Single-model speech-to-speech with ~200-300ms latency.",
  configSchema: voiceRealtimeConfigSchema,

  register(api: any) {
    config = voiceRealtimeConfigSchema.parse(api.pluginConfig);
    callManager = new CallManager();
    twilioClient = new TwilioClient(config);
    server = new VoiceServer(config, callManager, twilioClient);

    const logger = api.logger as { info: (m: string) => void; warn: (m: string) => void; error: (m: string) => void };

    callManager.setOnComplete((callId, record) => {
      logger.info(`[voice-rt] Call ${callId} completed: ${record.outcome?.summary || record.status}`);
    });

    // Register the make_phone_call tool
    api.registerTool({
      name: "make_phone_call",
      label: "Make Phone Call",
      description:
        "Make an outbound phone call to a business or person. An AI caller will handle the " +
        "conversation naturally — it can make reservations, ask questions, check hours/pricing/availability, " +
        "book appointments, or handle any other phone task. Describe exactly what needs to be accomplished " +
        "in the 'task' field and the AI will carry out the conversation and report back with the result.",
      parameters: MakePhoneCallParams,
      async execute(_toolCallId: string, params: MakePhoneCallParamsType) {
        const result = await initiateCall(params, logger);
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
          details: result,
        };
      },
    });

    // Gateway method
    api.registerGatewayMethod(
      "voicecall-rt.call",
      async ({ params, respond }: { params: Record<string, unknown>; respond: (ok: boolean, payload?: unknown) => void }) => {
        try {
          const result = await initiateCall(params as any, logger);
          respond(result.success, result);
        } catch (err) {
          respond(false, { error: err instanceof Error ? err.message : String(err) });
        }
      }
    );

    api.registerGatewayMethod(
      "voicecall-rt.status",
      async ({ respond }: { respond: (ok: boolean, payload?: unknown) => void }) => {
        try {
          const result = await checkStatus(config, server.isListening());
          respond(true, result);
        } catch (err) {
          respond(false, { error: err instanceof Error ? err.message : String(err) });
        }
      }
    );

    api.registerGatewayMethod(
      "voicecall-rt.active",
      async ({ respond }: { respond: (ok: boolean, payload?: unknown) => void }) => {
        const active = callManager.getActiveCalls();
        respond(true, { calls: active.map((c) => ({ callId: c.callId, to: c.to, status: c.status, task: c.task })) });
      }
    );

    // CLI
    api.registerCli(
      ({ program }: { program: any }) => {
        const root = program
          .command("voicecall-rt")
          .description("Voice call commands (OpenAI Realtime)");

        root
          .command("call")
          .description("Make an outbound phone call")
          .requiredOption("-n, --number <phone>", "Phone number to call (E.164)")
          .requiredOption("-t, --task <description>", "What to accomplish on the call")
          .action(async (opts: { number: string; task: string }) => {
            const result = await initiateCall({ to: opts.number, task: opts.task }, logger);
            console.log(JSON.stringify(result, null, 2));
          });

        root
          .command("status")
          .description("Check setup status")
          .action(async () => {
            const result = await checkStatus(config, server.isListening());
            console.log(JSON.stringify(result, null, 2));
            if (result.ready) {
              console.log("\n✓ All checks passed. Ready to make calls.");
            } else {
              console.log("\n✗ Issues found:");
              for (const issue of result.issues) {
                console.log(`  - ${issue}`);
              }
            }
          });

        root
          .command("active")
          .description("List active calls")
          .action(async () => {
            const active = callManager.getActiveCalls();
            if (active.length === 0) {
              console.log("No active calls.");
            } else {
              for (const call of active) {
                console.log(`  ${call.callId}: ${call.to} (${call.status})`);
              }
            }
          });
      },
      { commands: ["voicecall-rt"] }
    );

    // Background service
    api.registerService({
      id: "voicecall-rt",
      async start() {
        await server.start();
        logger.info(`[voice-rt] Server started on ${config.server.bind}:${config.server.port}`);
      },
      async stop() {
        await server.stop();
        logger.info("[voice-rt] Server stopped");
      },
    });
  },
};

async function initiateCall(
  params: { to: string; task: string },
  logger: { info: (m: string) => void; error: (m: string) => void }
): Promise<{ success: boolean; callId: string; message: string; error?: string }> {
  const { to, task } = params;

  const callId = `call_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  logger.info(`[voice-rt] Initiating call ${callId} to ${to} — task: ${task}`);

  const callContext: CallContext = { task, direction: "outbound" };

  server.setCallContext(callId, callContext);
  callManager.createCall(callId, to, config.fromNumber, task);

  try {
    const result = await twilioClient.initiateCall({
      to,
      callId,
      publicUrl: config.publicUrl,
      timeoutSeconds: config.calls.timeoutSeconds,
      enableAmd: config.calls.enableAmd,
      maxDurationSeconds: config.calls.maxDurationSeconds,
    });

    callManager.setCallSid(callId, result.callSid);
    callManager.updateStatus(callId, "ringing");
    logger.info(`[voice-rt] Call ${callId} initiated (SID: ${result.callSid})`);

    return {
      success: true,
      callId,
      message: `Call initiated to ${to}. The AI caller will handle the conversation and report the outcome. Call ID: ${callId}`,
    };
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    callManager.setError(callId, errorMsg);
    callManager.updateStatus(callId, "failed");
    logger.error(`[voice-rt] Failed to initiate call ${callId}: ${errorMsg}`);

    return {
      success: false,
      callId,
      message: `Failed to initiate call to ${to}`,
      error: errorMsg,
    };
  }
}

export default voiceRealtimePlugin;
