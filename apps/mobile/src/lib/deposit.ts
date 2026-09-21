import type { AuroraDeposit } from "./api/types";

/**
 * What the deposit screen shows and asks for now. Pure, from the deposit row alone (docs/api-mobile.md, Deposits).
 *
 * - sign: connect mode waits for the one personal_sign of `signPayload.payload_json`.
 * - send: the user sends funds to `depositAddress` (with the memo, if any).
 * - wait: Aurora is moving the funds, or Mona-DeFi runs the step after settlement.
 * - convert: USDC arrived (swap mode). The phone signs the Curve swap through the relay.
 * - session: the funds arrived, but trading is off, so Mona-DeFi cannot move them into Perpl.
 * - done / refunded / failed: final.
 */
export type DepositPhase = "sign" | "send" | "wait" | "convert" | "session" | "done" | "refunded" | "failed";

export function depositPhase(d: Pick<AuroraDeposit, "status" | "afterStatus" | "nextStep" | "signPayload">): DepositPhase {
  switch (d.status) {
    case "awaiting_signature":
      return d.signPayload ? "sign" : "wait";
    case "awaiting_deposit":
    case "listening":
      return "send";
    case "processing":
    case "incomplete":
      return "wait";
    case "refunded":
      return "refunded";
    case "failed":
    case "expired":
      return "failed";
    case "settled":
      if (d.afterStatus === "needs_conversion" || (d.afterStatus === null && d.nextStep?.kind === "needs_conversion")) return "convert";
      if (d.afterStatus === "needs_session") return "session";
      if (d.afterStatus === "failed") return "failed";
      if (d.afterStatus === "funded" || d.afterStatus === "opened" || d.afterStatus === "ready" || d.afterStatus === "converted") return "done";
      return "wait";
  }
}

/** Poll while something can still change without the user. */
export const shouldPoll = (phase: DepositPhase) => phase === "send" || phase === "wait";

/** Final phases: the progress view stops and offers a new deposit. */
export const isFinal = (phase: DepositPhase) => phase === "done" || phase === "refunded" || phase === "failed";
