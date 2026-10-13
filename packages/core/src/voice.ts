// Voice with Deepgram: speech to text (Nova-3) and text to speech (Aura-2). The key stays on the server; the app sends audio here.
// Docs: https://developers.deepgram.com/reference/speech-to-text-api/listen and .../text-to-speech-api/speak
import { config } from "./config";

const API = "https://api.deepgram.com/v1";
/** Words of this product that a general model mishears. Nova-3 key-term prompting raises them. */
const KEYTERMS = ["Perpl", "AUSD", "MON", "Monad", "Nansen", "leverage", "long", "short", "stop-loss", "take-profit", "BTC", "ETH", "SOL", "HYPE", "USDC"];
const MAX_AUDIO_BYTES = 10 * 1024 * 1024;
const MAX_SPEAK_CHARS = 1800;

export const voiceEnabled = () => !!config().DEEPGRAM_API_KEY;
const key = () => {
  const k = config().DEEPGRAM_API_KEY;
  if (!k) throw new Error("Voice is not set up on this server.");
  return k;
};

export interface Transcript { transcript: string; confidence: number; durationSec: number | null }

/** Transcribe one recorded clip (webm, mp4/m4a, wav, mpeg). */
export async function transcribe(audio: ArrayBuffer, contentType: string): Promise<Transcript> {
  if (audio.byteLength === 0) throw new Error("The recording is empty.");
  if (audio.byteLength > MAX_AUDIO_BYTES) throw new Error("The recording is too long. Keep it under one minute.");
  const q = new URLSearchParams({ model: config().DEEPGRAM_STT_MODEL, smart_format: "true", numerals: "true", punctuate: "true" });
  for (const t of KEYTERMS) q.append("keyterm", t);
  const res = await fetch(`${API}/listen?${q}`, { method: "POST", headers: { authorization: `Token ${key()}`, "content-type": contentType || "application/octet-stream" }, body: audio, signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`Speech recognition failed (${res.status}): ${(await res.text()).slice(0, 200)}`);
  const d = (await res.json()) as { metadata?: { duration?: number }; results?: { channels?: { alternatives?: { transcript?: string; confidence?: number }[] }[] } };
  const alt = d.results?.channels?.[0]?.alternatives?.[0];
  return { transcript: (alt?.transcript ?? "").trim(), confidence: alt?.confidence ?? 0, durationSec: d.metadata?.duration ?? null };
}

/** Plain speech text: no markdown, no links, no long hex strings. */
export function speakable(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/https?:\/\/\S+/g, "")
    .replace(/0x[0-9a-fA-F]{12,}/g, "the address")
    .replace(/[*_`#>|]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_SPEAK_CHARS);
}

/** Speak a reply. Returns an MP3 stream. */
export async function speak(text: string, voice?: string): Promise<Response> {
  const clean = speakable(text);
  if (!clean) throw new Error("Nothing to say.");
  const model = voice && /^aura-2-[a-z]+-en$/.test(voice) ? voice : config().DEEPGRAM_TTS_MODEL;
  const res = await fetch(`${API}/speak?model=${model}&encoding=mp3`, { method: "POST", headers: { authorization: `Token ${key()}`, "content-type": "application/json" }, body: JSON.stringify({ text: clean }), signal: AbortSignal.timeout(30_000) });
  if (!res.ok || !res.body) throw new Error(`Speech failed (${res.status}): ${(await res.text()).slice(0, 200)}`);
  return res;
}
