/**
 * A minimal text/event-stream parser. The API sends frames as `data: <json>\n\n` (apps/api/src/server.ts).
 * The parser takes text chunks of any size and returns the complete `data` payloads.
 */
export class SseParser {
  private buffer = "";

  /** Add a chunk. Returns the data payload of each frame that is now complete. */
  push(chunk: string): string[] {
    this.buffer += chunk.replace(/\r\n?/g, "\n");
    const out: string[] = [];
    let cut: number;
    while ((cut = this.buffer.indexOf("\n\n")) >= 0) {
      const frame = this.buffer.slice(0, cut);
      this.buffer = this.buffer.slice(cut + 2);
      const data = frame
        .split("\n")
        .filter((l) => l.startsWith("data:"))
        .map((l) => l.slice(5).replace(/^ /, ""))
        .join("\n");
      if (data) out.push(data);
    }
    return out;
  }

  /** The payload of a last frame that had no blank line after it, if any. */
  flush(): string[] {
    const rest = this.buffer;
    this.buffer = "";
    return rest.trim() ? this.push(`${rest}\n\n`) : [];
  }
}
