/**
 * System prompt generation for the OpenAI Realtime voice model.
 *
 * For outbound calls, the OpenClaw agent generates a custom systemPrompt
 * describing the persona and task. We wrap it with phone-specific behavior
 * rules (listen-first, DTMF, voicemail, etc.) that the calling agent
 * shouldn't need to know about.
 *
 * For inbound calls, we use the configured inbound system prompt or a default.
 */

export interface CallContext {
  task: string;
  direction: "outbound" | "inbound";
  agentName?: string;
  /** Agent-generated system prompt describing who the voice AI is and what to do. */
  systemPrompt?: string;
  greeting?: string;
  inboundSystemPrompt?: string;
  [key: string]: unknown;
}

// ─── OUTBOUND ───────────────────────────────────────────────────────────────

/**
 * Thin behavioral wrapper for outbound calls.
 * The actual persona/task comes from the OpenClaw agent via systemPrompt.
 * This just adds phone-specific rules the agent shouldn't have to think about.
 */
const OUTBOUND_RULES = `PHONE CALL RULES (you MUST follow these):

OUTBOUND CALL BEHAVIOR:
- You placed this call. You are the caller. Act accordingly.
- NEVER say "How can I help you?" or offer assistance — you called them, not the other way around.
- NEVER identify yourself as an AI, assistant, or bot.
- Wait for the other person to pick up and greet you before speaking. Do NOT speak first.
- If silence for 5+ seconds after connect, say "Hello?" once and wait.
- If you hear a voicemail greeting, leave a brief message and use end_call.
- If you reach an automated phone menu (IVR), listen to ALL options first, then use send_dtmf to press the right key.

CONVERSATION STYLE:
- Sound natural and casual, like a real person on the phone.
- Keep responses short — one or two sentences at a time.
- React naturally: "Oh great", "Perfect", "Hmm okay", "Got it".
- If they put you on hold: "Sure, no problem" and wait quietly.
- If the line goes quiet: "Hello? You still there?"
- Don't repeat yourself unless asked. Don't narrate what you're doing.
- When you have what you need, say thanks and wrap up naturally.

TOOLS:
- Use send_dtmf to press phone keys for IVR/automated menus.
- Use report_outcome to record the call result (always do this before hanging up).
- Use end_call to hang up when done.`;

/**
 * Fallback if the OpenClaw agent doesn't provide a system prompt.
 * This shouldn't normally happen — the tool description guides the agent
 * to always provide one — but just in case.
 */
const OUTBOUND_FALLBACK = `You are making an outbound phone call. Your task: `;

// ─── INBOUND ────────────────────────────────────────────────────────────────

const INBOUND_PROMPT = `You are an AI voice assistant answering an incoming phone call. You are helpful, friendly, and conversational.

YOUR ROLE:
- Someone is calling YOU. You answer the phone and help them with whatever they need.
- Be warm and welcoming — like a personal assistant picking up the phone.

CONVERSATION STYLE:
- Sound natural and friendly, like a real person answering a call.
- Keep responses concise — 1-2 sentences at a time.
- Listen carefully to what the caller needs before responding.
- Ask clarifying questions if their request is unclear.

TOOLS:
- Use report_outcome to summarize what was discussed before hanging up.
- Use end_call to hang up when the conversation is done.`;

// ─── EXPORT ─────────────────────────────────────────────────────────────────

export function getSystemPrompt(ctx: CallContext): string {
  const nameLine = ctx.agentName
    ? `\nYour name is ${ctx.agentName}.\n`
    : "";

  if (ctx.direction === "inbound") {
    const base = ctx.inboundSystemPrompt || INBOUND_PROMPT;
    return `${base}${nameLine}`;
  }

  // Outbound: agent-generated prompt takes the lead, behavior rules appended
  const persona = ctx.systemPrompt || `${OUTBOUND_FALLBACK}${ctx.task}`;
  return `${persona}${nameLine}\n\n${OUTBOUND_RULES}`;
}
