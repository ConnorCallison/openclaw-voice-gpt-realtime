/**
 * openclaw-voice-gpt-realtime
 *
 * Ultra-low-latency AI phone calls powered by OpenAI's Realtime API.
 * Replaces the multi-step STT → LLM → TTS pipeline with a single
 * speech-to-speech model for ~200-300ms response latency.
 */

import { parseConfig, type PluginConfig } from "./src/config.ts";
import { CallManager } from "./src/call-manager.ts";
import { TwilioClient } from "./src/twilio-client.ts";
import { VoiceServer } from "./src/server.ts";
import { checkStatus } from "./src/status.ts";
import type { CallIntent, CallContext } from "./src/prompts.ts";

let config: PluginConfig;
let callManager: CallManager;
let twilioClient: TwilioClient;
let server: VoiceServer;

/**
 * OpenClaw Plugin Registration
 *
 * This is the entry point that OpenClaw calls when loading the plugin.
 * It registers tools, gateway methods, services, and CLI commands.
 */
export default function register(api: OpenClawPluginAPI) {
  // Parse and validate config
  config = parseConfig(api.getConfig());
  callManager = new CallManager();
  twilioClient = new TwilioClient(config);
  server = new VoiceServer(config, callManager, twilioClient);

  // Set up callback for when calls complete
  callManager.setOnComplete((callId, record) => {
    api.log("info", `Call ${callId} completed: ${record.outcome?.summary || record.status}`);
    // Report result back to the conversation if there's a callback
    if (record.outcome) {
      api.emitEvent("voicecall-rt.call.completed", {
        callId,
        to: record.to,
        status: record.status,
        duration: record.duration,
        outcome: record.outcome,
        transcript: record.transcript,
      });
    }
  });

  // Register the make_phone_call tool for the LLM agent
  api.registerTool({
    name: "make_phone_call",
    description:
      "Make an outbound phone call to a business on behalf of the user. " +
      "Uses AI to have a natural phone conversation for reservations, " +
      "appointments, inquiries, etc. The AI will wait for the other person " +
      "to answer before speaking, navigate IVR menus, and report the outcome.",
    parameters: {
      type: "object",
      properties: {
        to: {
          type: "string",
          description: "Phone number to call in E.164 format (e.g. +14155551234)",
        },
        intent: {
          type: "string",
          enum: ["restaurant_reservation", "appointment_booking", "price_inquiry", "general_inquiry", "custom"],
          description: "The purpose of the call, which determines the AI's conversation strategy",
        },
        context: {
          type: "object",
          description:
            "Intent-specific details. For restaurant_reservation: partySize, date, time, specialRequests. " +
            "For appointment_booking: serviceType, preferredTimes. " +
            "For price_inquiry: inquirySubject. " +
            "For general_inquiry or custom: any relevant details.",
          properties: {
            businessName: { type: "string", description: "Name of the business being called" },
            partySize: { type: "number", description: "Number of people (for reservations)" },
            date: { type: "string", description: "Preferred date (e.g. 'Friday March 7th')" },
            time: { type: "string", description: "Preferred time (e.g. '7:00 PM')" },
            specialRequests: { type: "string", description: "Any special requests or notes" },
            serviceType: { type: "string", description: "Type of service (for appointments)" },
            preferredTimes: {
              type: "array",
              items: { type: "string" },
              description: "List of preferred time slots",
            },
            inquirySubject: { type: "string", description: "What to inquire about" },
            userName: { type: "string", description: "Name to use for the reservation/appointment" },
          },
        },
        customPrompt: {
          type: "string",
          description: "Optional custom system prompt that overrides the default intent-based prompt",
        },
      },
      required: ["to", "intent", "context"],
    },
    handler: async (args: ToolArgs) => {
      return await initiateCall(args, api);
    },
  });

  // Register gateway method for programmatic access
  api.registerGatewayMethod("voicecall-rt.call", async (params: ToolArgs) => {
    return await initiateCall(params, api);
  });

  // Register background service (HTTP + WebSocket server)
  api.registerService({
    name: "voice-server",
    start: async () => {
      await server.start();
      api.log("info", `Voice server started on ${config.server.bind}:${config.server.port}`);
    },
    stop: async () => {
      await server.stop();
      api.log("info", "Voice server stopped");
    },
  });

  // Register CLI commands
  api.registerCommand({
    name: "voicecall-rt",
    description: "Voice call commands (OpenAI Realtime)",
    subcommands: {
      call: {
        description: "Make an outbound phone call",
        args: {
          number: { type: "string", description: "Phone number to call", required: true },
          intent: {
            type: "string",
            description: "Call intent",
            default: "general_inquiry",
          },
          context: { type: "string", description: "JSON context object" },
          debug: { type: "boolean", description: "Enable debug mode for this call" },
        },
        handler: async (args: CLIArgs) => {
          const ctx = args.context ? JSON.parse(args.context as string) : {};
          const result = await initiateCall(
            {
              to: args.number as string,
              intent: (args.intent as CallIntent) || "general_inquiry",
              context: ctx,
            },
            api
          );
          console.log(JSON.stringify(result, null, 2));
        },
      },
      status: {
        description: "Check setup status",
        handler: async () => {
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
        },
      },
      active: {
        description: "List active calls",
        handler: async () => {
          const active = callManager.getActiveCalls();
          if (active.length === 0) {
            console.log("No active calls.");
          } else {
            for (const call of active) {
              console.log(`  ${call.callId}: ${call.to} (${call.status}) - ${call.intent}`);
            }
          }
        },
      },
    },
  });
}

/**
 * Initiate an outbound phone call.
 */
async function initiateCall(
  args: ToolArgs,
  api: OpenClawPluginAPI
): Promise<{
  success: boolean;
  callId: string;
  message: string;
  error?: string;
}> {
  const { to, intent, context = {}, customPrompt } = args;

  // Generate a unique call ID
  const callId = `call_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

  api.log("info", `Initiating call ${callId} to ${to} (intent: ${intent})`);

  // Build call context for the system prompt
  const callContext: CallContext = {
    intent: intent as CallIntent,
    customPrompt: customPrompt as string | undefined,
    ...(context as Record<string, unknown>),
  };

  // Store call context for when the WebSocket connects
  server.setCallContext(callId, callContext);

  // Create call record
  callManager.createCall(callId, to as string, config.fromNumber, intent as CallIntent);

  try {
    // Initiate the call via Twilio
    const result = await twilioClient.initiateCall({
      to: to as string,
      callId,
      publicUrl: config.publicUrl,
      timeoutSeconds: config.calls.timeoutSeconds,
      enableAmd: config.calls.enableAmd,
      maxDurationSeconds: config.calls.maxDurationSeconds,
    });

    callManager.setCallSid(callId, result.callSid);
    callManager.updateStatus(callId, "ringing");

    api.log("info", `Call ${callId} initiated (SID: ${result.callSid})`);

    return {
      success: true,
      callId,
      message: `Call initiated to ${to}. The AI assistant will handle the conversation and report the outcome. Call ID: ${callId}`,
    };
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    callManager.setError(callId, errorMsg);
    callManager.updateStatus(callId, "failed");

    api.log("error", `Failed to initiate call ${callId}: ${errorMsg}`);

    return {
      success: false,
      callId,
      message: `Failed to initiate call to ${to}`,
      error: errorMsg,
    };
  }
}

// Type definitions for the OpenClaw Plugin API
// These represent the expected API surface that OpenClaw provides to plugins

interface ToolArgs {
  [key: string]: unknown;
}

interface CLIArgs {
  [key: string]: unknown;
}

interface OpenClawPluginAPI {
  getConfig(): unknown;
  log(level: "info" | "warn" | "error" | "debug", message: string): void;
  emitEvent(event: string, data: unknown): void;

  registerTool(tool: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
    handler: (args: ToolArgs) => Promise<unknown>;
  }): void;

  registerGatewayMethod(name: string, handler: (params: ToolArgs) => Promise<unknown>): void;

  registerService(service: {
    name: string;
    start: () => Promise<void>;
    stop: () => Promise<void>;
  }): void;

  registerCommand(command: {
    name: string;
    description: string;
    subcommands: Record<
      string,
      {
        description: string;
        args?: Record<string, { type: string; description: string; required?: boolean; default?: unknown }>;
        handler: (args: CLIArgs) => Promise<void>;
      }
    >;
  }): void;
}
