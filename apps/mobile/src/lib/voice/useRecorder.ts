/**
 * Hold-to-talk state: idle → starting → recording → transcribing → idle.
 * Max 60 s (then it stops and sends by itself). A cancel drops the audio.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { MAX_RECORD_MS, MIN_RECORD_MS, VoiceError, type ActiveRecording } from "./core";
import { transcribe } from "./http";
import { startRecording } from "./recorder";

export type RecorderPhase = "idle" | "starting" | "recording" | "transcribing";

export function useVoiceRecorder({ onTranscript, onError }: { onTranscript: (text: string) => void; onError: (e: VoiceError) => void }) {
  const [phase, setPhase] = useState<RecorderPhase>("idle");
  const [elapsed, setElapsed] = useState(0);
  const rec = useRef<ActiveRecording | null>(null);
  const starting = useRef<Promise<ActiveRecording | null> | null>(null);
  const startedAt = useRef(0);
  const abort = useRef<AbortController | null>(null);
  const cb = useRef({ onTranscript, onError });
  cb.current = { onTranscript, onError };

  const fail = (e: unknown) => cb.current.onError(e instanceof VoiceError ? e : new VoiceError("other"));

  /** Call from the press handler with no await before it (Safari needs the gesture). */
  const start = useCallback(() => {
    if (rec.current || starting.current) return;
    setPhase("starting");
    setElapsed(0);
    starting.current = startRecording().then(
      (r) => {
        rec.current = r;
        startedAt.current = Date.now();
        setPhase("recording");
        return r;
      },
      (e) => {
        setPhase("idle");
        fail(e);
        return null;
      },
    ).finally(() => {
      starting.current = null;
    });
  }, []);

  const cancel = useCallback(() => {
    abort.current?.abort();
    const pending = starting.current;
    if (pending) void pending.then((r) => r?.cancel());
    rec.current?.cancel();
    rec.current = null;
    setPhase("idle");
    setElapsed(0);
  }, []);

  /** Stop, upload and hand the transcript to onTranscript. */
  const stop = useCallback(async () => {
    const r = rec.current ?? (await starting.current);
    rec.current = null;
    if (!r) return;
    setPhase("transcribing");
    try {
      const audio = await r.stop();
      if (audio.size < 200 || audio.durationMs < MIN_RECORD_MS) throw new VoiceError("empty");
      abort.current = new AbortController();
      const t = await transcribe(audio.body, audio.contentType, abort.current.signal);
      cb.current.onTranscript(t.transcript.trim());
    } catch (e) {
      if ((e as Error)?.name !== "AbortError") fail(e);
    } finally {
      abort.current = null;
      setPhase("idle");
      setElapsed(0);
    }
  }, []);

  // The live timer, and the 60 s limit.
  useEffect(() => {
    if (phase !== "recording") return;
    const t = setInterval(() => {
      const ms = Date.now() - startedAt.current;
      setElapsed(ms);
      if (ms >= MAX_RECORD_MS) void stop();
    }, 200);
    return () => clearInterval(t);
  }, [phase, stop]);

  useEffect(() => () => cancel(), [cancel]);

  return { phase, elapsed, start, stop, cancel, active: phase !== "idle" };
}
