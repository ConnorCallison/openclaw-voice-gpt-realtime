/**
 * Intent-based system prompts for the OpenAI Realtime model.
 * Prompts are dynamic — they adapt to the specific task and context.
 * The AI speaks like a normal person making a phone call, not a robot.
 */

export type CallIntent =
  | "restaurant_reservation"
  | "appointment_booking"
  | "price_inquiry"
  | "general_inquiry"
  | "custom";

export interface CallContext {
  intent: CallIntent;
  businessName?: string;
  partySize?: number;
  date?: string;
  time?: string;
  specialRequests?: string;
  serviceType?: string;
  preferredTimes?: string[];
  inquirySubject?: string;
  customPrompt?: string;
  userName?: string;
  [key: string]: unknown;
}

const CORE_IDENTITY = `You are a normal person making an outbound phone call. You sound casual, friendly, and human — like someone calling a business to get something done. You are NOT a receptionist, NOT an assistant offering help, NOT a customer service agent. You are the CALLER with a specific reason for calling.

NEVER say things like "How can I help you?" or "What can I do for you?" — YOU called THEM. You have a purpose and you stay on task.`;

const OUTBOUND_BEHAVIOR = `OUTBOUND CALL RULES:
- You are placing this call. The other person doesn't know you're calling.
- Wait for them to pick up and say hello before you speak.
- If silence for 5+ seconds after connect, just say "Hello?" and wait.
- If you hear voicemail, leave a short message and hang up with end_call.
- If you hit an automated phone menu (IVR), listen to all options first, then use send_dtmf to press the right key.`;

const TALK_LIKE_A_HUMAN = `HOW TO TALK:
- Sound like a regular person, not an AI. Keep it casual and natural.
- Short responses. Don't ramble or over-explain.
- If they ask you to hold, say "Sure, no problem" and wait.
- If the line drops or goes quiet, say "Hello? You still there?"
- Don't repeat yourself unless asked. Don't narrate what you're doing.
- When you have what you need, say thanks and wrap up.
- Use report_outcome before you hang up to record what happened.
- Use end_call when you're done.`;

function describeTask(ctx: CallContext): string {
  const parts: string[] = [];

  switch (ctx.intent) {
    case "restaurant_reservation": {
      let task = "You're calling to make a reservation";
      if (ctx.businessName) task += ` at ${ctx.businessName}`;
      task += ".";
      parts.push(task);
      if (ctx.partySize) parts.push(`Party of ${ctx.partySize}.`);
      if (ctx.date) parts.push(`Date: ${ctx.date}.`);
      if (ctx.time) parts.push(`Time: ${ctx.time}.`);
      if (ctx.specialRequests) parts.push(`Special requests: ${ctx.specialRequests}.`);
      if (ctx.userName) parts.push(`Name for the reservation: ${ctx.userName}.`);
      parts.push("");
      parts.push("After they answer, tell them you'd like to make a reservation and give them the details. If your preferred time isn't available, ask what's open and pick the closest one. Confirm the details before hanging up.");
      break;
    }
    case "appointment_booking": {
      let task = "You're calling to book an appointment";
      if (ctx.businessName) task += ` at ${ctx.businessName}`;
      task += ".";
      parts.push(task);
      if (ctx.serviceType) parts.push(`For: ${ctx.serviceType}.`);
      if (ctx.preferredTimes?.length) parts.push(`Preferred times: ${ctx.preferredTimes.join(", ")}.`);
      if (ctx.date) parts.push(`Date: ${ctx.date}.`);
      if (ctx.time) parts.push(`Time: ${ctx.time}.`);
      if (ctx.userName) parts.push(`Name: ${ctx.userName}.`);
      parts.push("");
      parts.push("Tell them what you need and when. Be flexible on timing if needed. Give them your name and info if they ask. Confirm everything before hanging up.");
      break;
    }
    case "price_inquiry": {
      let task = "You're calling to ask about pricing";
      if (ctx.businessName) task += ` at ${ctx.businessName}`;
      task += ".";
      parts.push(task);
      if (ctx.inquirySubject) parts.push(`Specifically about: ${ctx.inquirySubject}.`);
      parts.push("");
      parts.push("Ask what it costs, what's included, if there are any deals or packages. Get specific numbers. Ask about taxes or fees if it seems relevant. Take note of everything they tell you.");
      break;
    }
    case "general_inquiry": {
      let task = "You're calling to get some information";
      if (ctx.businessName) task += ` from ${ctx.businessName}`;
      task += ".";
      parts.push(task);
      if (ctx.inquirySubject) parts.push(`You want to know about: ${ctx.inquirySubject}.`);

      // Build a dynamic task description from any extra context fields
      const knownKeys = new Set(["intent", "businessName", "partySize", "date", "time", "specialRequests", "serviceType", "preferredTimes", "inquirySubject", "customPrompt", "userName"]);
      const extras = Object.entries(ctx).filter(([k, v]) => !knownKeys.has(k) && v !== undefined);
      for (const [key, value] of extras) {
        parts.push(`${key}: ${value}.`);
      }

      parts.push("");
      parts.push("Ask your question clearly. Follow up if the answer isn't complete. Make sure you have everything you need before wrapping up.");
      break;
    }
    case "custom":
      // Handled separately
      break;
  }

  return parts.join("\n");
}

export function getSystemPrompt(ctx: CallContext): string {
  if (ctx.intent === "custom" && ctx.customPrompt) {
    return `${CORE_IDENTITY}\n\n${ctx.customPrompt}\n\n${OUTBOUND_BEHAVIOR}\n\n${TALK_LIKE_A_HUMAN}`;
  }

  const task = describeTask(ctx);
  return `${CORE_IDENTITY}\n\nYOUR TASK:\n${task}\n\n${OUTBOUND_BEHAVIOR}\n\n${TALK_LIKE_A_HUMAN}`;
}
