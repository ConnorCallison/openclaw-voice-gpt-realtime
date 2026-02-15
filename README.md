# openclaw-voice-gpt-realtime

Ultra-low-latency AI phone calls powered by OpenAI's Realtime API for [OpenClaw](https://github.com/openclaw).

Replaces the traditional multi-step voice pipeline (STT -> LLM -> TTS) with a single speech-to-speech model, cutting response latency from ~500-1000ms+ down to **~200-300ms**.

## Architecture

```
User (via iMessage/CLI) --> OpenClaw Agent --> make_phone_call tool
                                                |
                                       Plugin: initiateCall()
                                                |
                                       Twilio REST API --> PSTN --> Business
                                                | (call answered)
                                       Twilio hits /voice/answer webhook
                                                |
                                       Returns TwiML: <Connect><Stream>
                                                |
                              Twilio WebSocket <--> Plugin WebSocket Server
                                                |
                              OpenAI Realtime API WebSocket (gpt-realtime)
                                   g711_ulaw passthrough, zero transcoding
                                   Function calling (DTMF, end_call, report)
```

**Before (old pipeline):** Twilio audio -> OpenAI STT -> LLM (gpt-4.1-mini) -> ElevenLabs TTS -> Twilio audio (~500-1000ms+)

**After (this plugin):** Twilio audio -> OpenAI Realtime (gpt-realtime) -> Twilio audio (~200-300ms)

## Features

- **~200-300ms response latency** — Single model inference, zero transcoding
- **Natural voice** — OpenAI's `coral` voice (configurable)
- **"Listen first" outbound behavior** — AI waits for the callee to answer before speaking
- **IVR navigation** — DTMF tone generation for navigating phone menus
- **Voicemail detection** — Leaves a brief message and hangs up
- **Intent-based prompts** — Tailored conversation strategies per call type
- **Call transcripts** — Full transcript logging with timestamps
- **Debug mode** — Call recording, verbose WebSocket logging, latency metrics
- **Status checker** — Built-in verification of Twilio, OpenAI, tunnel, and server

## Quick Start

### 1. Install

```bash
# Clone the repo
git clone https://github.com/connorcallison/openclaw-voice-gpt-realtime.git
cd openclaw-voice-gpt-realtime
bun install

# Install as OpenClaw plugin (local symlink)
openclaw plugins install -l .
```

### 2. Configure

Add to your `openclaw.json`:

```json
{
  "plugins": {
    "entries": {
      "openclaw-voice-gpt-realtime": {
        "enabled": true,
        "config": {
          "twilio": {
            "accountSid": "ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
            "authToken": "your-auth-token"
          },
          "fromNumber": "+17077024785",
          "openai": {
            "apiKey": "sk-proj-...",
            "model": "gpt-realtime",
            "voice": "coral"
          },
          "publicUrl": "https://your-domain.com",
          "server": {
            "port": 3335,
            "bind": "127.0.0.1"
          },
          "debug": false
        }
      }
    }
  }
}
```

### 3. Set Up Tunnel

Route `/voice/*` to port 3335 via your reverse proxy (Cloudflare Tunnel, ngrok, etc.):

```yaml
# Cloudflare Tunnel example
- hostname: your-domain.com
  path: /voice/realtime-stream
  service: http://localhost:3335
  originRequest:
    noTLSVerify: true
    connectTimeout: 300s
    keepAliveTimeout: 300s
- hostname: your-domain.com
  path: /voice/.*
  service: http://localhost:3335
```

### 4. Verify

```bash
openclaw voicecall-rt status
```

### 5. Make a Call

Via the OpenClaw agent (iMessage, CLI, etc.):

> "Call Tony's Pizza at +14155551234 and make a reservation for 4 people this Friday at 7pm"

Or via CLI:

```bash
openclaw voicecall-rt call +14155551234 \
  --intent restaurant_reservation \
  --context '{"businessName":"Tony'\''s Pizza","partySize":4,"date":"Friday","time":"7:00 PM"}'
```

## Call Intents

| Intent | Description | Context Fields |
|--------|-------------|----------------|
| `restaurant_reservation` | Make a restaurant reservation | `partySize`, `date`, `time`, `specialRequests` |
| `appointment_booking` | Book an appointment | `serviceType`, `preferredTimes` |
| `price_inquiry` | Ask about pricing | `inquirySubject` |
| `general_inquiry` | General question | Any relevant details |
| `custom` | Custom prompt | `customPrompt` (overrides default) |

## Configuration Reference

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `twilio.accountSid` | string | required | Twilio Account SID |
| `twilio.authToken` | string | required | Twilio Auth Token |
| `fromNumber` | string | required | Twilio phone number (E.164) |
| `openai.apiKey` | string | required | OpenAI API key |
| `openai.model` | string | `gpt-realtime` | OpenAI Realtime model |
| `openai.voice` | string | `coral` | AI voice |
| `vad.type` | string | `semantic_vad` | VAD type |
| `vad.eagerness` | string | `medium` | VAD eagerness |
| `publicUrl` | string | required | Public URL for webhooks |
| `server.port` | number | `3335` | Server port |
| `server.bind` | string | `127.0.0.1` | Bind address |
| `calls.maxDurationSeconds` | number | `600` | Max call duration |
| `calls.timeoutSeconds` | number | `30` | Ring timeout |
| `calls.enableAmd` | boolean | `true` | Answering machine detection |
| `debug` | boolean | `false` | Debug mode |

## Debug Mode

Enable with `"debug": true` in config or `--debug` on CLI. This activates:

- **Call recording** — Raw mu-law + WAV files saved to `~/.openclaw/voice-calls-realtime/recordings/`
- **Verbose logging** — Every WebSocket event with timestamps and color coding
- **Latency metrics** — Speech-end to AI-response-start timing
- **Full transcripts** — JSON transcript files alongside recordings

## How It Works

1. **Call initiation** — Plugin calls Twilio REST API to place an outbound call
2. **Twilio connects** — Twilio hits the `/voice/answer` webhook, gets TwiML with `<Connect><Stream>`
3. **WebSocket bridge** — Twilio opens a WebSocket to the plugin, which opens another to OpenAI Realtime
4. **Audio passthrough** — g711_ulaw audio flows directly between Twilio and OpenAI (zero transcoding)
5. **"Listen first"** — No initial `response.create`; semantic VAD detects the callee's greeting naturally
6. **Conversation** — OpenAI handles the full conversation with function calling for DTMF, hangup, and reporting
7. **Outcome** — Model calls `report_outcome` with structured results, then `end_call`
8. **Callback** — Plugin emits results back to the OpenClaw conversation

## Cost Estimate

Per-call pricing (approximate):

| Component | Cost | Notes |
|-----------|------|-------|
| OpenAI Realtime (audio input) | ~$0.06/min | gpt-realtime |
| OpenAI Realtime (audio output) | ~$0.24/min | gpt-realtime |
| Twilio voice | ~$0.014/min | Outbound US |
| **Total** | **~$0.31/min** | ~$1.55 for a 5-minute call |

## Requirements

- [Bun](https://bun.sh) runtime
- [OpenClaw](https://github.com/openclaw) installed and configured
- Twilio account with a voice-capable phone number
- OpenAI API key with Realtime API access
- Public URL (Cloudflare Tunnel, ngrok, Tailscale Funnel, etc.)

## License

MIT
