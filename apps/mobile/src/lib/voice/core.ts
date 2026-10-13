/** Voice (Deepgram through the server): the pure parts, shared by web and native and tested in Jest. */
import type { Intent } from "../api/types";
import { num, price } from "../format";

/** The longest recording. The server takes up to 10 MB, which is about one minute. */
export const MAX_RECORD_MS = 60_000;
/** A press shorter than this is a tap: the recording then stays on until the next tap (tap-to-toggle). */
export const HOLD_MIN_MS = 350;
/** The transcript waits this long in the input before it goes to the agent. The user can edit or cancel. */
export const SEND_DELAY_MS = 1_500;
/** A recording shorter than this has no speech. */
export const MIN_RECORD_MS = 400;

/** The MediaRecorder types, best first. Chrome and Firefox record Opus in WebM. Safari records AAC in MP4. */
export const WEB_MIME_CANDIDATES = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/mp4;codecs=mp4a.40.2", "audio/ogg;codecs=opus"] as const;

/** Pick the MediaRecorder mime type. Returns "" when none is supported: the browser then uses its default. */
export function pickMimeType(isTypeSupported: ((t: string) => boolean) | undefined): string {
  if (!isTypeSupported) return "";
  for (const t of WEB_MIME_CANDIDATES) {
    try {
      if (isTypeSupported(t)) return t;
    } catch {
      // Some browsers throw for unknown types.
    }
  }
  return "";
}

/**
 * The content-type for POST /voice/transcribe, from a mime type or a file name / extension.
 * The server takes audio/webm, audio/mp4, audio/wav and audio/mpeg.
 */
export function contentTypeFor(mimeOrName: string): string {
  const v = mimeOrName.toLowerCase().trim();
  const base = v.split(";")[0]!.trim();
  if (base.startsWith("audio/") || base.startsWith("video/")) {
    if (base.endsWith("/webm")) return "audio/webm";
    if (base.endsWith("/mp4") || base.endsWith("/m4a") || base.endsWith("/x-m4a") || base.endsWith("/aac")) return "audio/mp4";
    if (base.endsWith("/wav") || base.endsWith("/x-wav") || base.endsWith("/wave")) return "audio/wav";
    if (base.endsWith("/mpeg") || base.endsWith("/mp3")) return "audio/mpeg";
    if (base.endsWith("/ogg")) return "audio/ogg";
    return base;
  }
  const ext = /\.?([a-z0-9]+)$/.exec(v.split("?")[0]!)?.[1] ?? "";
  switch (ext) {
    case "webm":
      return "audio/webm";
    case "m4a":
    case "mp4":
    case "aac":
    case "caf":
      return "audio/mp4";
    case "wav":
      return "audio/wav";
    case "mp3":
      return "audio/mpeg";
    default:
      return "audio/mp4"; // expo-audio records AAC in an m4a file on iOS and Android.
  }
}

/** The longest text that the app sends to /voice/speak. A spoken reply should be short; the server limit is 8000. */
export const MAX_SPEAK_CHARS = 1_200;

/**
 * The text to speak: no markdown, no links, no long hex strings, no code blocks; cut at a sentence end.
 * The server cleans the text too. This keeps the request small and the reply short. Returns "" when nothing is left.
 */
export function speakableText(markdown: string, max = MAX_SPEAK_CHARS): string {
  let t = markdown.replace(/\r\n?/g, "\n");
  t = t.replace(/```[\s\S]*?(```|$)/g, " "); // code blocks: not read aloud
  t = t.replace(/!\[[^\]]*\]\([^)]*\)/g, " "); // images
  t = t.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1"); // links: the label only
  t = t.replace(/https?:\/\/\S+/g, " ");
  t = t.replace(/\b0x[0-9a-fA-F]{16,}\b/g, "an address");
  t = t.replace(/`([^`]*)`/g, "$1");
  t = t.replace(/^[ \t]*\|?[ \t]*:?-{2,}.*$/gm, ""); // table separator rows
  t = t.replace(/[ \t]*\|[ \t]*/g, ", ");
  t = t.replace(/^\s{0,3}#{1,6}\s+(.*)$/gm, "$1.");
  t = t.replace(/^[ \t]*>\s?/gm, "");
  t = t.replace(/^[ \t]*([-*+]|\d+[.)])\s+/gm, "");
  t = t.replace(/^[ \t]*([-*_]\s*){3,}$/gm, "");
  t = t.replace(/(\*\*|__|\*|_|~~)/g, "");
  t = t.replace(/\.\.(?=\s|$)/g, ".");
  t = t.replace(/^[ \t,]+|[ \t,]+$/gm, "");
  t = t.replace(/\n{2,}/g, "\n").replace(/[ \t]+/g, " ").replace(/\s*\n\s*/g, " ").trim();
  if (t.length <= max) return t;
  const cut = t.slice(0, max);
  const end = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf("! "), cut.lastIndexOf("? "));
  return (end > max * 0.4 ? cut.slice(0, end + 1) : `${cut.slice(0, cut.lastIndexOf(" ") > 0 ? cut.lastIndexOf(" ") : max)}…`).trim();
}

/** One spoken sentence for a confirmed (or failed) order card. */
export function intentResultSentence(intent: Intent): string | null {
  const r = intent.result;
  if (intent.status === "failed") return `The order failed. ${r?.error ? String(r.error).split("\n")[0] : "No funds moved."}`;
  if (intent.status === "rejected") return "Order rejected. Nothing was sent.";
  if (intent.status !== "done") return null;
  const parts: string[] = ["Done."];
  if (r?.avgFillPx !== undefined) parts.push(`Filled ${num(r.filledSize, 6)} at ${price(r.avgFillPx)}.`);
  if (r?.restingOrderIds?.length) parts.push("The order rests on the Perpl book.");
  if (r?.closedSize !== undefined) parts.push(`Closed ${num(r.closedSize, 4)}.`);
  if (r?.positionAfter?.liquidationPx) parts.push(`Liquidation price ${price(r.positionAfter.liquidationPx)}.`);
  return parts.join(" ");
}

export type VoiceErrorKind = "permission" | "empty" | "rate" | "off" | "unsupported" | "other";

/** Plain words for each voice error. */
export const VOICE_ERROR_TEXT: Record<VoiceErrorKind, string> = {
  permission: "Mona-DeFi cannot use the microphone. Allow microphone access in your settings, then try again.",
  empty: "The recording was empty. Hold the mic button and speak.",
  rate: "Too many voice requests. Wait a minute and try again.",
  off: "Voice is off on this server.",
  unsupported: "This browser cannot record audio. Type your message instead.",
  other: "Voice did not work. Try again or type your message.",
};

export class VoiceError extends Error {
  constructor(public readonly kind: VoiceErrorKind, message = VOICE_ERROR_TEXT[kind]) {
    super(message);
    this.name = "VoiceError";
  }
}

/** The error for an HTTP answer of /voice/transcribe or /voice/speak. */
export function voiceHttpError(status: number, serverText?: string): VoiceError {
  if (status === 429) return new VoiceError("rate");
  if (status === 503) return new VoiceError("off");
  if (status === 0) return new VoiceError("other", "The Mona-DeFi server did not answer. Check your connection and try again.");
  return new VoiceError("other", serverText || VOICE_ERROR_TEXT.other);
}

/** "0:07" for the recording timer. */
export function clock(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/** A finished recording, ready for POST /voice/transcribe. */
export interface RecordedAudio {
  body: Blob | Uint8Array;
  contentType: string;
  durationMs: number;
  size: number;
}

export interface ActiveRecording {
  stop(): Promise<RecordedAudio>;
  cancel(): void;
}
