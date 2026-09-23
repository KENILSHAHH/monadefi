import type { AuroraDeposit } from "../src/lib/api/types";
import { depositPhase, isFinal, shouldPoll } from "../src/lib/deposit";

const base: Pick<AuroraDeposit, "status" | "afterStatus" | "nextStep" | "signPayload"> = { status: "awaiting_deposit", afterStatus: null, nextStep: null, signPayload: null };

describe("Aurora deposit phases", () => {
  it("connect: sign first, then send", () => {
    expect(depositPhase({ ...base, status: "awaiting_signature", signPayload: { standard: "erc191", payload_json: "{}" } })).toBe("sign");
    expect(depositPhase({ ...base, status: "awaiting_deposit" })).toBe("send");
  });

  it("moving funds polls; final states stop", () => {
    expect(shouldPoll(depositPhase({ ...base, status: "processing" }))).toBe(true);
    expect(shouldPoll(depositPhase({ ...base, status: "incomplete" }))).toBe(true);
    expect(depositPhase({ ...base, status: "refunded" })).toBe("refunded");
    expect(depositPhase({ ...base, status: "expired" })).toBe("failed");
    expect(isFinal("refunded")).toBe(true);
  });

  it("swap: settled USDC asks for the conversion", () => {
    expect(depositPhase({ ...base, status: "settled", afterStatus: "needs_conversion" })).toBe("convert");
    expect(depositPhase({ ...base, status: "settled", nextStep: { kind: "needs_conversion", usdc: 25 } })).toBe("convert");
    expect(shouldPoll("convert")).toBe(false);
  });

  it("after settlement", () => {
    expect(depositPhase({ ...base, status: "settled", afterStatus: "needs_session" })).toBe("session");
    for (const a of ["funded", "opened", "ready", "converted"] as const) expect(depositPhase({ ...base, status: "settled", afterStatus: a })).toBe("done");
    expect(depositPhase({ ...base, status: "settled", afterStatus: "failed" })).toBe("failed");
    expect(depositPhase({ ...base, status: "settled", afterStatus: null, nextStep: { kind: "fund_perpl", ausd: 25 } })).toBe("wait");
  });
});
