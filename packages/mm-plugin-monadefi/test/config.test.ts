import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { describeConfig, getConfig, setConfig, slippageBps, unsetConfig } from "../src/lib/config";

beforeEach(() => {
  process.env.MONADEFI_CONFIG_DIR = mkdtempSync(join(tmpdir(), "monadefi-cfg-"));
  delete process.env.NANSEN_API_KEY;
  delete process.env.MONADEFI_SLIPPAGE_BPS;
});

describe("plugin config", () => {
  it("stores keys in a 0600 file and never shows a secret value", () => {
    setConfig("nansen-key", "nk_live_abcdef");
    const file = join(process.env.MONADEFI_CONFIG_DIR!, "config.json");
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(file, "utf8"))["nansen-key"]).toBe("nk_live_abcdef");
    expect(getConfig("nansen-key")).toBe("nk_live_abcdef");
    const view = describeConfig("nansen-key");
    expect(view).toMatchObject({ set: true, source: "file" });
    expect(JSON.stringify(view)).not.toContain("nk_live");
  });

  it("prefers the environment over the file", () => {
    setConfig("nansen-key", "from-file");
    process.env.NANSEN_API_KEY = "from-env";
    expect(getConfig("nansen-key")).toBe("from-env");
    expect(describeConfig("nansen-key").source).toBe("env");
  });

  it("validates slippage and falls back to the default", () => {
    expect(slippageBps()).toBe(50);
    setConfig("slippage-bps", "75");
    expect(slippageBps()).toBe(75);
    expect(slippageBps("120")).toBe(120);
    expect(() => setConfig("slippage-bps", "1000")).toThrow(/1 to 300/);
    expect(describeConfig("slippage-bps").value).toBe("75");
    unsetConfig("slippage-bps");
    expect(slippageBps()).toBe(50);
  });
});
