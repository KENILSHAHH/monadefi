/** Native playback of the spoken reply with expo-audio. The MP3 bytes go to a cache file first. */
import { createAudioPlayer, setAudioModeAsync, type AudioPlayer } from "expo-audio";
import { File, Paths } from "expo-file-system";

let player: AudioPlayer | null = null;
let file: File | null = null;
let finish: (() => void) | null = null;
let generation = 0;

/** Only the web build needs a gesture to unlock audio. */
export function unlockAudio() {}

export function stopPlayback() {
  generation++;
  const p = player;
  player = null;
  try {
    p?.pause();
    p?.remove();
  } catch {
    // already released
  }
  try {
    file?.delete();
  } catch {
    // ignore
  }
  file = null;
  finish?.();
  finish = null;
}

/** Play MP3 bytes. Resolves when the audio ends or stopPlayback() runs. */
export async function playMp3(bytes: ArrayBuffer): Promise<void> {
  stopPlayback();
  const mine = generation;
  const f = new File(Paths.cache, `mona-speak-${Date.now()}.mp3`);
  f.create({ overwrite: true });
  f.write(new Uint8Array(bytes));
  await setAudioModeAsync({ playsInSilentMode: true, allowsRecording: false }).catch(() => undefined);
  if (mine !== generation) {
    try {
      f.delete();
    } catch {
      // ignore
    }
    return;
  }
  file = f;
  const p = createAudioPlayer({ uri: f.uri });
  player = p;
  await new Promise<void>((resolve) => {
    finish = resolve;
    const sub = p.addListener("playbackStatusUpdate", (s) => {
      if (s.didJustFinish) {
        sub.remove();
        if (player === p) stopPlayback();
      }
    });
    p.play();
  });
}
