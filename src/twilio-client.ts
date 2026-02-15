import twilio from "twilio";
import type { PluginConfig } from "./config.ts";

export interface InitiateCallOptions {
  to: string;
  callId: string;
  publicUrl: string;
  timeoutSeconds: number;
  enableAmd: boolean;
  maxDurationSeconds: number;
}

export interface TwilioCallResult {
  callSid: string;
  status: string;
}

export class TwilioClient {
  private client: twilio.Twilio;
  private config: PluginConfig;

  constructor(config: PluginConfig) {
    this.config = config;
    this.client = twilio(config.twilio.accountSid, config.twilio.authToken);
  }

  async initiateCall(opts: InitiateCallOptions): Promise<TwilioCallResult> {
    const twimlUrl = `${opts.publicUrl}/voice/answer?callId=${encodeURIComponent(opts.callId)}`;
    const statusUrl = `${opts.publicUrl}/voice/status?callId=${encodeURIComponent(opts.callId)}`;

    const callParams: Record<string, unknown> = {
      to: opts.to,
      from: this.config.fromNumber,
      url: twimlUrl,
      statusCallback: statusUrl,
      statusCallbackEvent: ["initiated", "ringing", "answered", "completed"],
      statusCallbackMethod: "POST",
      timeout: opts.timeoutSeconds,
      timeLimit: opts.maxDurationSeconds,
    };

    if (opts.enableAmd) {
      const amdUrl = `${opts.publicUrl}/voice/amd?callId=${encodeURIComponent(opts.callId)}`;
      callParams.machineDetection = "DetectMessageEnd";
      callParams.asyncAmd = "true";
      callParams.asyncAmdStatusCallback = amdUrl;
      callParams.asyncAmdStatusCallbackMethod = "POST";
    }

    const call = await this.client.calls.create(callParams as unknown as Parameters<typeof this.client.calls.create>[0]);

    return {
      callSid: call.sid,
      status: call.status,
    };
  }

  async hangup(callSid: string): Promise<void> {
    await this.client.calls(callSid).update({ status: "completed" });
  }

  async verifyAccount(): Promise<{
    ok: boolean;
    accountSid: string;
    friendlyName?: string;
    error?: string;
  }> {
    try {
      const account = await this.client.api.accounts(this.config.twilio.accountSid).fetch();
      return {
        ok: true,
        accountSid: this.maskSid(account.sid),
        friendlyName: account.friendlyName,
      };
    } catch (err) {
      return {
        ok: false,
        accountSid: this.maskSid(this.config.twilio.accountSid),
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  async verifyPhoneNumber(): Promise<{
    ok: boolean;
    number: string;
    capabilities?: { voice: boolean; sms: boolean };
    error?: string;
  }> {
    try {
      const numbers = await this.client.incomingPhoneNumbers.list({
        phoneNumber: this.config.fromNumber,
        limit: 1,
      });

      if (numbers.length === 0) {
        return {
          ok: false,
          number: this.config.fromNumber,
          error: "Phone number not found in your Twilio account",
        };
      }

      const num = numbers[0];
      return {
        ok: true,
        number: this.config.fromNumber,
        capabilities: {
          voice: num.capabilities?.voice ?? false,
          sms: num.capabilities?.sms ?? false,
        },
      };
    } catch (err) {
      return {
        ok: false,
        number: this.config.fromNumber,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  private maskSid(sid: string): string {
    if (sid.length <= 6) return sid;
    return sid.slice(0, 4) + "..." + sid.slice(-4);
  }
}
