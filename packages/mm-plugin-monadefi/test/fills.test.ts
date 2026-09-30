import { PERPL_EXCHANGE, perplAbi } from "@app/perpl";
import { encodeEventTopics, encodeAbiParameters, type Log, type AbiEvent } from "viem";
import { describe, expect, it } from "vitest";
import { readFills } from "../src/lib/fills";
import { ETH } from "./fixtures";

function log(name: string, values: unknown[], address: string = PERPL_EXCHANGE): Log {
  const ev = perplAbi.find((x) => x.type === "event" && x.name === name) as AbiEvent;
  const topics = encodeEventTopics({ abi: [ev], eventName: name } as never);
  const data = encodeAbiParameters(ev.inputs, values as never);
  return { address, topics, data, blockHash: null, blockNumber: null, logIndex: 0, transactionHash: null, transactionIndex: 0, removed: false } as unknown as Log;
}

describe("receipt fills", () => {
  it("reads fills, fees and the unfilled rest of an IOC order", () => {
    const logs = [
      log("TakerOrderFilledV2", [250050n, 250050n, 250050n, 100n, 8000n, 0n, 0n, 0n, 0n]),
      log("TakerOrderFilledV2", [250100n, 250100n, 250100n, 60n, 5000n, 0n, 0n, 0n, 0n]),
      log("ImmediateOrCancelExecuted", [0n, 160n]),
      log("TakerOrderFilledV2", [1n, 1n, 1n, 999n, 1n, 0n, 0n, 0n, 0n], "0x0000000000000000000000000000000000000001"),
    ];
    const r = readFills(ETH, logs);
    expect(r.filledSize).toBeCloseTo(0.016);
    expect(r.avgFillPx).toBeCloseTo((2500.5 * 0.01 + 2501 * 0.006) / 0.016);
    expect(r.feeUsd).toBeCloseTo(0.013);
    expect(r.notFilled).toBe(0);
    expect(r.events).toEqual(["TakerOrderFilledV2", "TakerOrderFilledV2", "ImmediateOrCancelExecuted"]);
  });

  it("reads a resting order id", () => {
    const r = readFills(ETH, [log("OrderPlaced", [7n, 160n, 0n, 0n, 0n])]);
    expect(r.restingOrderIds).toEqual([7]);
    expect(r.filledSize).toBe(0);
    expect(r.avgFillPx).toBeNull();
  });
});
