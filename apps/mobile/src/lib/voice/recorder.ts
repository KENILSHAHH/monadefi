/** Native recording with expo-audio: AAC in an m4a file, read back as bytes. The web build uses recorder.web.ts. */
import { AudioModule, RecordingPresets, requestRecordingPermissionsAsync, setAudioModeAsync } from "expo-audio";
import { File } from "expo-file-system";
import { Platform } from "react-native";
import { contentTypeFor, VoiceError, type ActiveRecording, type RecordedAudio } from "./core";

export const recordingSupported = () => true;

export async function startRecording(): Promise<ActiveRecording> {
  const perm = await requestRecordingPermissionsAsync();
  if (!perm.granted) throw new VoiceError("permission");
  await setAudioModeAsync({ allowsRecording: true, playsInSilentMode: true });
  const p = RecordingPresets.HIGH_QUALITY;
  // Speech: one channel at 64 kbit/s keeps one minute near 0.5 MB (the server takes 10 MB).
  const options = {
    extension: p.extension, sampleRate: 44_100, numberOfChannels: 1, bitRate: 64_000, isMeteringEnabled: false,
    ...(Platform.OS === "ios" ? p.ios : p.android),
  };
  // The same flat options that useAudioRecorder builds for the platform.
  const rec = new AudioModule.AudioRecorder(options as never);
  try {
    await rec.prepareToRecordAsync();
    rec.record();
  } catch {
    rec.release();
    await setAudioModeAsync({ allowsRecording: false }).catch(() => undefined);
    throw new VoiceError("other", "The microphone could not start. Try again.");
  }
  const started = Date.now();
  let done = false;

  const finish = async () => {
    done = true;
    await rec.stop().catch(() => undefined);
    // Back to playback mode, so the spoken reply comes from the speaker and not the earpiece.
    await setAudioModeAsync({ allowsRecording: false, playsInSilentMode: true }).catch(() => undefined);
    const uri = rec.uri;
    rec.release();
    return uri;
  };

  return {
    async stop(): Promise<RecordedAudio> {
      if (done) throw new VoiceError("empty");
      const uri = await finish();
      if (!uri) throw new VoiceError("empty");
      const file = new File(uri);
      const bytes = file.exists ? await file.bytes() : new Uint8Array();
      try {
        file.delete();
      } catch {
        // The cache is cleared by the system anyway.
      }
      return { body: bytes, contentType: contentTypeFor(uri), durationMs: Date.now() - started, size: bytes.byteLength };
    },
    cancel() {
      if (done) return;
      void finish().then((uri) => {
        try {
          if (uri) new File(uri).delete();
        } catch {
          // ignore
        }
      });
    },
  };
}
