import { clock, contentTypeFor, intentResultSentence, MAX_SPEAK_CHARS, pickMimeType, speakableText, voiceHttpError } from "../src/lib/voice/core";
import type { Intent } from "../src/lib/api/types";

describe("voice: MediaRecorder mime selection", () => {
  it("Chrome / Firefox: Opus in WebM first", () => {
    expect(pickMimeType((t) => t.startsWith("audio/webm"))).toBe("audio/webm;codecs=opus");
  });
  it("Safari: no WebM, so MP4", () => {
    expect(pickMimeType((t) => t === "audio/mp4")).toBe("audio/mp4");
  });
  it("no support or no isTypeSupported: the browser default", () => {
    expect(pickMimeType(() => false)).toBe("");
    expect(pickMimeType(undefined)).toBe("");
  });
  it("a throwing isTypeSupported does not break the choice", () => {
    expect(pickMimeType((t) => {
      if (t.includes("opus")) throw new Error("bad");
      return t === "audio/webm";
    })).toBe("audio/webm");
  });
});

describe("voice: content-type for /voice/transcribe", () => {
  it.each([
    ["audio/webm;codecs=opus", "audio/webm"],
    ["audio/webm", "audio/webm"],
    ["video/webm", "audio/webm"],
    ["audio/mp4", "audio/mp4"],
    ["audio/mp4;codecs=mp4a.40.2", "audio/mp4"],
    ["audio/x-m4a", "audio/mp4"],
    ["audio/aac", "audio/mp4"],
    ["audio/wav", "audio/wav"],
    ["audio/x-wav", "audio/wav"],
    ["audio/mpeg", "audio/mpeg"],
    ["file:///var/mobile/Containers/Data/Caches/ExpoAudio/recording-1.m4a", "audio/mp4"],
    ["recording.wav", "audio/wav"],
    ["voice.mp3", "audio/mpeg"],
    ["clip.webm", "audio/webm"],
  ])("%s → %s", (input, out) => {
    expect(contentTypeFor(input)).toBe(out);
  });
});

describe("voice: speakable text", () => {
  it("removes markdown, links, URLs, code and long hex", () => {
    const md = "## Your ETH long\n\n**Filled** at *2,400* AUSD. See [Monadscan](https://monadscan.com/tx/0xabc).\n\n- Margin `20 AUSD`\n- Wallet 0x1234567890abcdef1234567890abcdef12345678\n\n```ts\nconst x = 1;\n```\nhttps://example.com done";
    const t = speakableText(md);
    expect(t).toBe("Your ETH long. Filled at 2,400 AUSD. See Monadscan. Margin 20 AUSD Wallet an address done");
    expect(t).not.toMatch(/[*#`[\]]|https?:/);
  });

  it("tables become short spoken lists", () => {
    expect(speakableText("| Market | Funding |\n|---|---|\n| ETH | 0.01% |")).toBe("Market, Funding ETH, 0.01%");
  });

  it("cuts long text at a sentence end", () => {
    const long = Array.from({ length: 200 }, (_, i) => `Sentence number ${i} is here.`).join(" ");
    const t = speakableText(long);
    expect(t.length).toBeLessThanOrEqual(MAX_SPEAK_CHARS);
    expect(t.endsWith(".")).toBe(true);
  });

  it("empty when nothing is left to say", () => {
    expect(speakableText("```\ncode only\n```")).toBe("");
  });
});

describe("voice: helpers", () => {
  it("HTTP errors in plain words", () => {
    expect(voiceHttpError(429).message).toBe("Too many voice requests. Wait a minute and try again.");
    expect(voiceHttpError(503).message).toBe("Voice is off on this server.");
    expect(voiceHttpError(400, "Deepgram: bad audio").message).toBe("Deepgram: bad audio");
  });

  it("clock", () => {
    expect(clock(0)).toBe("0:00");
    expect(clock(7_400)).toBe("0:07");
    expect(clock(60_000)).toBe("1:00");
  });

  it("result line of a confirmed card", () => {
    const base = { id: "i", kind: "perpl", params: {}, preview: {}, feeUsd: 0, createdAt: "" } as unknown as Intent;
    expect(intentResultSentence({ ...base, status: "done", result: { avgFillPx: 2400, filledSize: 0.01 } })).toMatch(/^Done\. Filled 0\.01 at /);
    expect(intentResultSentence({ ...base, status: "failed", result: { error: "Out of margin." } })).toBe("The order failed. Out of margin.");
    expect(intentResultSentence({ ...base, status: "pending", result: null })).toBeNull();
  });
});
