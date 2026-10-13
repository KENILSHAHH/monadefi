/**
 * Browser playback of the spoken reply: an Audio element with a blob URL.
 * Safari plays audio only after a user gesture played it once, so unlockAudio() runs on the first tap
 * (the mic button or the speaker toggle) and the same element plays every reply after that.
 */
let el: HTMLAudioElement | null = null;
let url: string | null = null;
let finish: (() => void) | null = null;
let unlocked = false;

// 0.05 s of silence (MPEG-1 Layer III).
const SILENCE =
  "data:audio/mpeg;base64,SUQzBAAAAAAAI1RTU0UAAAAPAAADTGF2ZjU2LjM2LjEwMAAAAAAAAAAAAAAA//OEAAAAAAAAAAAAAAAAAAAAAAAASW5mbwAAAA8AAAAEAAABIADAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDV1dXV1dXV1dXV1dXV1dXV1dXV1dXV1dXV6urq6urq6urq6urq6urq6urq6urq6urq6v////////////////////////////////8AAAAATGF2YzU2LjQxAAAAAAAAAAAAAAAAJAAAAAAAAAAAASDs90hvAAAAAAAAAAAAAAAAAAAA//MUZAAAAAGkAAAAAAAAA0gAAAAATEFN//MUZAMAAAGkAAAAAAAAA0gAAAAARTMu//MUZAYAAAGkAAAAAAAAA0gAAAAAOTku//MUZAkAAAGkAAAAAAAAA0gAAAAANVVV";

function audio(): HTMLAudioElement | null {
  if (typeof Audio === "undefined") return null;
  el ??= new Audio();
  el.preload = "auto";
  return el;
}

/** Call from a tap handler. Plays a short silence on the shared element so later plays are allowed. */
export function unlockAudio() {
  if (unlocked) return;
  const a = audio();
  if (!a) return;
  unlocked = true;
  try {
    a.src = SILENCE;
    a.volume = 0;
    void a.play().then(
      () => {
        a.pause();
        a.volume = 1;
      },
      () => {
        a.volume = 1;
        unlocked = false;
      },
    );
  } catch {
    unlocked = false;
  }
}

export function stopPlayback() {
  if (el && !el.paused && el.src !== SILENCE) el.pause();
  if (url) URL.revokeObjectURL(url);
  url = null;
  finish?.();
  finish = null;
}

/** Play MP3 bytes. Resolves when the audio ends or stopPlayback() runs. */
export async function playMp3(bytes: ArrayBuffer): Promise<void> {
  stopPlayback();
  const a = audio();
  if (!a) return;
  url = URL.createObjectURL(new Blob([bytes], { type: "audio/mpeg" }));
  a.src = url;
  a.volume = 1;
  await new Promise<void>((resolve) => {
    finish = resolve;
    a.onended = () => stopPlayback();
    a.onerror = () => stopPlayback();
    a.play().catch(() => stopPlayback());
  });
}
