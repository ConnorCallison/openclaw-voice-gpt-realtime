# Changelog

## 0.1.2 (2026-02-16)

- Security hardening for `publicUrl`: now requires HTTPS origin-only URLs and blocks localhost/private/internal hosts.
- Twilio webhook authentication hardened: signed headers are now required on POST webhook routes.
- Prompt safety upgraded: added non-overridable legal/safety guardrails, prompt sanitization/truncation, and removed deceptive identity directives.
- Privacy hardening for local artifacts: call logs/debug recordings now use restrictive filesystem permissions.
- Packaging metadata cleanup: removed incorrect install metadata that implied the package creates a `bun` binary.

## 0.1.0 (2026-02-14)

- Initial release
- OpenAI Realtime API integration for speech-to-speech calls
- Twilio WebSocket media stream bridge
- "Listen first" outbound call behavior
- Intent-based system prompts (restaurant, appointment, price inquiry, general, custom)
- DTMF tone generation for IVR navigation
- Call state management and transcript persistence
- Debug mode with call recording and verbose logging
- Built-in status checker for setup verification
