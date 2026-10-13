/**
 * POST /voice/transcribe (raw audio bytes) and POST /voice/speak (MP3 back).
 * expo/fetch sends a Blob, an expo-file-system File or bytes on iOS and Android. On web it is the browser fetch.
 */
import { fetch as expoFetch } from "expo/fetch";
import { authHeader, currentToken, renewAuthToken } from "../api/client";
import { config } from "../config";
import { VoiceError, voiceHttpError } from "./core";

type Body = Blob | ArrayBuffer | Uint8Array;

async function post(path: string, body: Body | string, contentType: string, accept: string, signal?: AbortSignal) {
  const go = (token: string | null) =>
    expoFetch(`${config.apiUrl}${path}`, {
      method: "POST",
      headers: { "content-type": contentType, accept, ...authHeader(token) },
      body: body as never,
      ...(signal ? { signal } : {}),
    });
  let res;
  try {
    res = await go(currentToken());
    if (res.status === 401) {
      const t = await renewAuthToken();
      if (t) res = await go(t);
    }
  } catch (e) {
    if ((e as Error)?.name === "AbortError") throw e;
    throw voiceHttpError(0);
  }
  if (!res.ok) {
    const b = (await res.json().catch(() => ({}))) as { error?: string };
    throw voiceHttpError(res.status, b.error);
  }
  return res;
}

export interface Transcript {
  transcript: string;
  confidence?: number;
  durationSec?: number;
}

export async function transcribe(audio: Body, contentType: string, signal?: AbortSignal): Promise<Transcript> {
  const res = await post("/voice/transcribe", audio, contentType, "application/json", signal);
  const t = (await res.json()) as Transcript;
  if (!t.transcript?.trim()) throw new VoiceError("empty", "Mona-DeFi heard no words. Hold the mic button and speak again.");
  return t;
}

/** The spoken reply as MP3 bytes. */
export async function speakBytes(text: string, signal?: AbortSignal): Promise<ArrayBuffer> {
  const res = await post("/voice/speak", JSON.stringify({ text }), "application/json", "audio/mpeg", signal);
  return res.arrayBuffer();
}
