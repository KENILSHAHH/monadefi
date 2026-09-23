import { toViemAccount } from "@category-labs/mera/viem";
import { hashTypedData, recoverTypedDataAddress } from "viem";
import { recoverAuthorizationAddress } from "viem/utils";
import { deriveAccount } from "../src/lib/mera/derive";
import type { AgentEvent, Intent, TypedDataPayload } from "../src/lib/api/types";
import { applyEvent, type ChatMessage } from "../src/lib/chatModel";
import { SseParser } from "../src/lib/sse";
import { normalizeTypedData } from "../src/lib/typedData";

describe("SSE parser", () => {
  it("splits frames across chunk borders", () => {
    const p = new SseParser();
    expect(p.push('data: {"type":"text","de')).toEqual([]);
    expect(p.push('lta":"Hi"}\n\ndata: {"type":"done"}\n')).toEqual(['{"type":"text","delta":"Hi"}']);
    expect(p.push("\n")).toEqual(['{"type":"done"}']);
  });

  it("handles CRLF, comments and a last frame without a blank line", () => {
    const p = new SseParser();
    expect(p.push(": keep-alive\r\n\r\ndata: 1\r\n\r\n")).toEqual(["1"]);
    expect(p.push("data: 2")).toEqual([]);
    expect(p.flush()).toEqual(["2"]);
  });
});

describe("chat model", () => {
  const intent = (status: Intent["status"]): Intent => ({ id: "int_1", kind: "perpl", params: {}, preview: {}, status, feeUsd: 0, result: null, createdAt: "" });

  it("joins text deltas, tracks tools and replaces an intent in place", () => {
    const events: AgentEvent[] = [
      { type: "text", delta: "Opening " },
      { type: "text", delta: "a long." },
      { type: "tool", id: "t1", name: "perpl_markets", input: {} },
      { type: "tool_result", id: "t1", isError: false, preview: "ok" },
      { type: "intent", intent: intent("pending") },
      { type: "intent", intent: intent("done") },
    ];
    const m = events.reduce(applyEvent, { role: "assistant", parts: [] } as ChatMessage);
    expect(m.parts).toHaveLength(3);
    expect(m.parts[0]).toEqual({ kind: "text", text: "Opening a long." });
    expect(m.parts[1]).toMatchObject({ kind: "tool", id: "t1", result: "ok", isError: false });
    expect(m.parts[2]).toMatchObject({ kind: "intent", intent: { status: "done" } });
  });

  it("keeps the error text", () => {
    expect(applyEvent({ role: "assistant", parts: [] }, { type: "error", message: "Out of credit." }).error).toBe("Out of credit.");
  });
});

// The shape of packages/core/src/session.ts: the salt is a decimal string, EIP712Domain is in types.
const payload: TypedDataPayload = {
    domain: { name: "DelegationManager", version: "1", chainId: 143, verifyingContract: "0xdb9B1e94B5b69Df7e401DDbedE43491141047dB3" },
    types: {
      EIP712Domain: [
        { name: "name", type: "string" }, { name: "version", type: "string" }, { name: "chainId", type: "uint256" }, { name: "verifyingContract", type: "address" },
      ],
      Caveat: [{ name: "enforcer", type: "address" }, { name: "terms", type: "bytes" }],
      Delegation: [
        { name: "delegate", type: "address" }, { name: "delegator", type: "address" }, { name: "authority", type: "bytes32" },
        { name: "caveats", type: "Caveat[]" }, { name: "salt", type: "uint256" },
      ],
    },
    primaryType: "Delegation",
    message: {
      delegate: "0x1111111111111111111111111111111111111111",
      delegator: "0x2222222222222222222222222222222222222222",
      authority: "0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
      caveats: [{ enforcer: "0x3333333333333333333333333333333333333333", terms: "0x1234" }],
      salt: "123456789012345678901234567890",
    },
  };

describe("typed data from the server", () => {
  it("turns decimal strings of integer fields into bigint and leaves the rest", () => {
    const n = normalizeTypedData(payload);
    expect(n.message.salt).toBe(123456789012345678901234567890n);
    expect(n.message.delegate).toBe(payload.message.delegate);
    expect((n.message.caveats as { terms: string }[])[0]!.terms).toBe("0x1234");
  });

  it("hashes to the same digest as the bigint form the server verifies", () => {
    const n = normalizeTypedData(payload);
    const serverForm = { ...payload, message: { ...payload.message, salt: 123456789012345678901234567890n } };
    expect(hashTypedData(n as never)).toBe(hashTypedData(serverForm as never));
  });
});

describe("signatures the server verifies", () => {
  it("EIP-7702 authorization from the Mera account recovers to the wallet (POST /session/upgrade body)", async () => {
    const { session, address } = await deriveAccount(new Uint8Array(32).fill(7));
    const account = toViemAccount(session);
    const implementation = "0x63c0c19a282a1B52b07dD5a65b58948A07DAE32B" as const;
    const auth = await account.signAuthorization!({ chainId: 143, contractAddress: implementation, nonce: 0 });
    expect(auth).toMatchObject({ address: implementation, chainId: 143, nonce: 0 });
    expect([0, 1]).toContain(auth.yParity);
    expect(await recoverAuthorizationAddress({ authorization: auth })).toBe(address);
    session.end();
  }, 30_000);

  it("EIP-712 delegation signed from the server payload recovers with the bigint salt", async () => {
    const { session, address } = await deriveAccount(new Uint8Array(32).fill(9));
    const account = toViemAccount(session);
    const signature = await account.signTypedData(normalizeTypedData(payload) as never);
    const serverForm = { ...payload, message: { ...payload.message, salt: 123456789012345678901234567890n } };
    expect(await recoverTypedDataAddress({ ...serverForm, signature } as never)).toBe(address);
    session.end();
  }, 30_000);
});
