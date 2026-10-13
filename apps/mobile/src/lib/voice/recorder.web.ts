/**
 * Browser recording with MediaRecorder: Opus in WebM (Chrome, Firefox) or AAC in MP4 (Safari).
 * Safari needs getUserMedia from the user gesture: startRecording() calls it first, with no await before it.
 */
import { contentTypeFor, pickMimeType, VoiceError, type ActiveRecording, type RecordedAudio } from "./core";

export const recordingSupported = () =>
  typeof navigator !== "undefined" && Boolean(navigator.mediaDevices?.getUserMedia) && typeof MediaRecorder !== "undefined";

function micError(e: unknown): VoiceError {
  const name = (e as { name?: string } | null)?.name;
  if (name === "NotAllowedError" || name === "SecurityError" || name === "PermissionDeniedError") return new VoiceError("permission");
  if (name === "NotFoundError" || name === "DevicesNotFoundError") return new VoiceError("other", "No microphone was found on this device.");
  return new VoiceError("other", "The microphone could not start. Try again.");
}

export function startRecording(): Promise<ActiveRecording> {
  if (!recordingSupported()) return Promise.reject(new VoiceError("unsupported"));
  // The first call in the press handler, so the browser sees the user gesture.
  const streamP = navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, channelCount: 1 } });
  return streamP.then(
    (stream) => {
      const mimeType = pickMimeType((t) => MediaRecorder.isTypeSupported(t));
      let rec: MediaRecorder;
      try {
        rec = new MediaRecorder(stream, mimeType ? { mimeType, audioBitsPerSecond: 64_000 } : undefined);
      } catch {
        rec = new MediaRecorder(stream);
      }
      const chunks: Blob[] = [];
      rec.ondataavailable = (e) => {
        if (e.data && e.data.size > 0) chunks.push(e.data);
      };
      const release = () => stream.getTracks().forEach((t) => t.stop());
      const started = Date.now();
      rec.start(250);

      return {
        stop: () =>
          new Promise<RecordedAudio>((resolve, reject) => {
            const done = () => {
              release();
              const type = rec.mimeType || mimeType || chunks[0]?.type || "audio/webm";
              const blob = new Blob(chunks, { type });
              resolve({ body: blob, contentType: contentTypeFor(type), durationMs: Date.now() - started, size: blob.size });
            };
            rec.onstop = done;
            rec.onerror = () => {
              release();
              reject(new VoiceError("other", "The recording failed. Try again."));
            };
            if (rec.state === "inactive") done();
            else rec.stop();
          }),
        cancel() {
          rec.onstop = null;
          try {
            if (rec.state !== "inactive") rec.stop();
          } catch {
            // ignore
          }
          release();
        },
      };
    },
    (e) => {
      throw micError(e);
    },
  );
}
