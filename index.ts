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
import type { CallIntent, CallContext } from "./src/prompts.ts";

const MakePhoneCallParams = Type.Object({
  to: Type.String({ description: "Phone number to call in E.164 format (e.g. +14155551234)" }),
  intent: Type.Union(
    [
      Type.Literal("restaurant_reservation"),
      Type.Literal("appointment_booking"),
      Type.Literal("price_inquiry"),
      Type.Literal("general_inquiry"),
      Type.Literal("custom"),
    ],
    { description: "The purpose of the call, which determines the AI's conversation strategy" }
  ),
  context: Type.Optional(
    Type.Object(
      {
        businessName: Type.Optional(Type.String({ description: "Name of the business being called" })),
        partySize: Type.Optional(Type.Number({ description: "Number of people (for reservations)" })),
        date: Type.Optional(Type.String({ description: "Preferred date (e.g. 'Friday March 7th')" })),
        time: Type.Optional(Type.String({ description: "Preferred time (e.g. '7:00 PM')" })),
        specialRequests: Type.Optional(Type.String({ description: "Any special requests or notes" })),
        serviceType: Type.Optional(Type.String({ description: "Type of service (for appointments)" })),
        preferredTimes: Type.Optional(Type.Array(Type.String(), { description: "List of preferred time slots" })),
        inquirySubject: Type.Optional(Type.String({ description: "What to inquire about" })),
        userName: Type.Optional(Type.String({ description: "Name to use for the reservation/appointment" })),
      },
      { description: "Intent-specific details", additionalProperties: true }
    )
  ),
  customPrompt: Type.Optional(
    Type.String({ description: "Optional custom system prompt that overrides the default intent-based prompt" })
  ),
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

    // Callback when calls complete
    callManager.setOnComplete((callId, record) => {
      logger.info(`[voice-rt] Call ${callId} completed: ${record.outcome?.summary || record.status}`);
    });

    // Register the make_phone_call tool
    api.registerTool({
      name: "make_phone_call",
      label: "Make Phone Call",
      description:
        "Make an outbound phone call to a business on behalf of the user. " +
        "Uses AI to have a natural phone conversation for reservations, " +
        "appointments, inquiries, etc. The AI will wait for the other person " +
        "to answer before speaking, navigate IVR menus, and report the outcome.",
      parameters: MakePhoneCallParams,
      async execute(_toolCallId: string, params: MakePhoneCallParamsType) {
        const result = await initiateCall(params, logger);
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
          details: result,
        };
      },
    });

    // Gateway method for programmatic access
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
        respond(true, { calls: active.map((c) => ({ callId: c.callId, to: c.to, status: c.status, intent: c.intent })) });
      }
    );

    // CLI commands
    api.registerCli(
      ({ program }: { program: any }) => {
        const root = program
          .command("voicecall-rt")
          .description("Voice call commands (OpenAI Realtime)");

        root
          .command("call")
          .description("Make an outbound phone call")
          .requiredOption("-n, --number <phone>", "Phone number to call (E.164)")
          .option("-i, --intent <type>", "Call intent", "general_inquiry")
          .option("-c, --context <json>", "JSON context object")
          .action(async (opts: { number: string; intent: string; context?: string }) => {
            const ctx = opts.context ? JSON.parse(opts.context) : {};
            const result = await initiateCall(
              { to: opts.number, intent: opts.intent as CallIntent, context: ctx },
              logger
            );
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
                console.log(`  ${call.callId}: ${call.to} (${call.status}) - ${call.intent}`);
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
  params: { to: string; intent: string; context?: Record<string, unknown>; customPrompt?: string },
  logger: { info: (m: string) => void; error: (m: string) => void }
): Promise<{ success: boolean; callId: string; message: string; error?: string }> {
  const { to, intent, context = {}, customPrompt } = params;

  const callId = `call_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  logger.info(`[voice-rt] Initiating call ${callId} to ${to} (intent: ${intent})`);

  const callContext: CallContext = {
    intent: intent as CallIntent,
    customPrompt,
    ...context,
  };

  server.setCallContext(callId, callContext);
  callManager.createCall(callId, to, config.fromNumber, intent as CallIntent);

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
      message: `Call initiated to ${to}. The AI assistant will handle the conversation and report the outcome. Call ID: ${callId}`,
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
