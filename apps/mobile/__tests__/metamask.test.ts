import { decodeFunctionData, erc20Abi, getAddress, parseUnits } from "viem";
import type { AuroraChain } from "../src/lib/api/types";
import {
  MON_GAS_RESERVE, MONAD_ADD_CHAIN, MONAD_TOKENS, auroraSendAmount, buildTransferTx, checkAuroraDestination, isPhoneUserAgent, maxSendable,
  metamaskDeepLink, metamaskErrorMessage, parseFundTarget, parseTokenAmount, providerErrorCode, sourceChains, switchChain, waitForReceipt,
  type Eip1193Provider,
} from "../src/lib/metamask/core";

const FROM = "0x1111111111111111111111111111111111111111";
const TO = "0x2222222222222222222222222222222222222222";
const AUSD = MONAD_TOKENS[0]!;

describe("amount parsing and units", () => {
  it("parses into base units", () => {
    expect(parseTokenAmount("25", 6)).toEqual({ ok: true, value: 25_000_000n });
    expect(parseTokenAmount("0.000001", 6)).toEqual({ ok: true, value: 1n });
    expect(parseTokenAmount(".5", 6)).toEqual({ ok: true, value: 500_000n });
    expect(parseTokenAmount("12.", 6)).toEqual({ ok: true, value: 12_000_000n });
    expect(parseTokenAmount("12,5", 6)).toEqual({ ok: true, value: 12_500_000n });
    expect(parseTokenAmount("1.5", 18)).toEqual({ ok: true, value: parseUnits("1.5", 18) });
  });

  it("rejects bad input", () => {
    for (const bad of ["", " ", "abc", "-1", "1e3", "1,000.5", "1.2.3", "0x10", "0", "0.000"]) expect(parseTokenAmount(bad, 6).ok).toBe(false);
    const r = parseTokenAmount("0.0000001", 6);
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error).toMatch(/6 decimals/);
  });

  it("Max keeps 0.01 MON for gas, never below zero", () => {
    expect(maxSendable(parseUnits("1", 18), true)).toBe(parseUnits("0.99", 18));
    expect(maxSendable(parseUnits("0.005", 18), true)).toBe(0n);
    expect(maxSendable(123n, false)).toBe(123n);
    expect(MON_GAS_RESERVE).toBe(10n ** 16n);
  });
});

describe("transfer tx builder", () => {
  it("ERC-20: to is the token, value 0, data is transfer(recipient, amount)", () => {
    const tx = buildTransferTx({ from: FROM, recipient: TO, amount: 25_000_000n, token: AUSD.address });
    expect(tx.to).toBe(getAddress(AUSD.address!));
    expect(tx.from).toBe(getAddress(FROM));
    expect(tx.value).toBe("0x0");
    const call = decodeFunctionData({ abi: erc20Abi, data: tx.data! });
    expect(call.functionName).toBe("transfer");
    expect(call.args).toEqual([getAddress(TO), 25_000_000n]);
    expect(tx.data!.slice(0, 10)).toBe("0xa9059cbb");
  });

  it("native: to is the recipient, value is the amount, no data", () => {
    const tx = buildTransferTx({ from: FROM, recipient: TO, amount: parseUnits("1.5", 18), token: null });
    expect(tx).toEqual({ from: getAddress(FROM), to: getAddress(TO), value: "0x14d1120d7b160000" });
    expect("data" in tx).toBe(false);
  });

  it("rejects a bad destination or a zero amount", () => {
    expect(() => buildTransferTx({ from: FROM, recipient: "0x123", amount: 1n, token: null })).toThrow(/destination/);
    expect(() => buildTransferTx({ from: FROM, recipient: TO, amount: 0n, token: null })).toThrow(/above zero/);
  });
});

describe("/fund address validation", () => {
  it("accepts a valid address and checksums it", () => {
    expect(parseFundTarget(TO)).toEqual({ ok: true, address: getAddress(TO) });
    expect(parseFundTarget(` ${TO.toUpperCase().replace("0X", "0x")} `).ok).toBe(true);
    expect(parseFundTarget([TO])).toEqual({ ok: true, address: getAddress(TO) });
  });

  it("rejects anything else", () => {
    for (const bad of [undefined, null, "", "0x123", "hello", "0x2222222222222222222222222222222222222222zz", [TO, TO], "0x0000000000000000000000000000000000000000"]) {
      expect(parseFundTarget(bad as never).ok).toBe(false);
    }
    // A mixed-case address with a wrong EIP-55 checksum.
    expect(parseFundTarget("0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAeD").ok).toBe(false);
    expect(parseFundTarget("0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed").ok).toBe(true);
  });
});

describe("MetaMask error codes", () => {
  it("maps codes to plain sentences", () => {
    expect(metamaskErrorMessage({ code: 4001, message: "User rejected the request." })).toBe("You cancelled in MetaMask.");
    expect(metamaskErrorMessage({ code: -32002 })).toMatch(/already open/);
    expect(metamaskErrorMessage({ code: 4100 })).toMatch(/did not allow/);
    expect(metamaskErrorMessage({ code: 4902 })).toMatch(/not in MetaMask/);
    expect(metamaskErrorMessage(new Error("insufficient funds for gas * price + value"))).toMatch(/enough funds/);
    expect(metamaskErrorMessage({})).toMatch(/MetaMask returned an error/);
  });

  it("finds the code inside a -32603 wrapper (MetaMask mobile)", () => {
    expect(providerErrorCode({ code: -32603, data: { originalError: { code: 4902 } } })).toBe(4902);
    expect(providerErrorCode({ code: -32603 })).toBe(-32603);
    expect(providerErrorCode("x")).toBeNull();
  });
});

describe("links", () => {
  it("builds the MetaMask link from the current origin", () => {
    expect(metamaskDeepLink("https://mona-defi.vercel.app", TO)).toBe(`https://metamask.app.link/dapp/mona-defi.vercel.app/fund?to=${TO}`);
    expect(metamaskDeepLink("http://localhost:8090/", TO)).toBe(`https://metamask.app.link/dapp/localhost:8090/fund?to=${TO}`);
  });

  it("detects phone browsers", () => {
    expect(isPhoneUserAgent("Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) Safari/604.1")).toBe(true);
    expect(isPhoneUserAgent("Mozilla/5.0 (Linux; Android 14) Chrome/130 Mobile Safari/537.36")).toBe(true);
    expect(isPhoneUserAgent("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Safari/605.1.15", 5)).toBe(true);
    expect(isPhoneUserAgent("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Chrome/130 Safari/537.36", 0)).toBe(false);
  });
});

/** A stub EIP-1193 provider that records calls. */
function stub(handlers: Record<string, (params: unknown) => unknown>) {
  const calls: { method: string; params?: unknown }[] = [];
  const p: Eip1193Provider = {
    request: async ({ method, params }) => {
      calls.push({ method, params });
      const h = handlers[method];
      if (!h) throw Object.assign(new Error(`no ${method}`), { code: 4200 });
      return h(params);
    },
  };
  return { p, calls };
}

describe("provider steps", () => {
  it("switch: adds Monad on 4902, then checks the chain", async () => {
    let chain = "0x1";
    const { p, calls } = stub({
      wallet_switchEthereumChain: () => {
        throw { code: 4902 };
      },
      wallet_addEthereumChain: () => {
        chain = "0x8f";
        return null;
      },
      eth_chainId: () => chain,
    });
    await switchChain(p, 143, MONAD_ADD_CHAIN, "Monad");
    expect(calls.map((c) => c.method)).toEqual(["wallet_switchEthereumChain", "wallet_addEthereumChain", "eth_chainId"]);
    expect(calls[1]!.params).toEqual([{ ...MONAD_ADD_CHAIN, chainId: "0x8f" }]);
  });

  it("switch: no add params asks the user to add the network", async () => {
    const { p } = stub({ wallet_switchEthereumChain: () => { throw { code: 4902 }; } });
    await expect(switchChain(p, 8453, null, "Base")).rejects.toThrow(/Add the Base network/);
  });

  it("switch: a wrong chain after the switch stops the flow", async () => {
    const { p } = stub({ wallet_switchEthereumChain: () => null, eth_chainId: () => "0x1" });
    await expect(switchChain(p, 143, MONAD_ADD_CHAIN, "Monad")).rejects.toThrow(/not on Monad/);
  });

  it("receipt: polls until mined, reports a revert and a timeout", async () => {
    let n = 0;
    const wait = jest.fn(async () => undefined);
    const ok = stub({ eth_getTransactionReceipt: () => (++n < 3 ? null : { status: "0x1", blockNumber: "0x10" }) });
    await expect(waitForReceipt(ok.p, "0xab", { wait })).resolves.toEqual({ status: "success", blockNumber: 16 });
    expect(wait).toHaveBeenCalledWith(2_000);
    const bad = stub({ eth_getTransactionReceipt: () => ({ status: "0x0" }) });
    await expect(waitForReceipt(bad.p, "0xab", { wait })).resolves.toEqual({ status: "reverted", blockNumber: null });
    let t = 0;
    const never = stub({ eth_getTransactionReceipt: () => null });
    await expect(waitForReceipt(never.p, "0xab", { wait: async (ms) => void (t += ms), now: () => t })).resolves.toEqual({ status: "timeout" });
    expect(t).toBeLessThanOrEqual(120_000);
  });
});

describe("other-chain (Aurora) data", () => {
  const chains: AuroraChain[] = [
    {
      chain: "base", name: "Base", evm: true, connect: true,
      tokens: [
        { assetId: "nep141:base.omft.near", symbol: "ETH", decimals: 18, contractAddress: null },
        { assetId: "nep141:base-usdc", symbol: "USDC", decimals: 6, contractAddress: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" },
        { assetId: "nep141:base-mystery", symbol: "XYZ", decimals: 18, contractAddress: null },
      ],
    },
    { chain: "sol", name: "Solana", evm: false, connect: false, tokens: [{ assetId: "sol", symbol: "SOL", decimals: 9 }] },
    { chain: "hood", name: "Robinhood Chain", evm: true, connect: true, tokens: [{ assetId: "h", symbol: "ETH", decimals: 18 }] },
  ];

  it("keeps EVM chains with a chain id and sendable tokens only", () => {
    const out = sourceChains(chains);
    expect(out.map((c) => c.key)).toEqual(["base"]);
    expect(out[0]!.chainId).toBe(8453);
    expect(out[0]!.add).toBeNull();
    expect(out[0]!.tokens.map((t) => [t.symbol, t.contract])).toEqual([["ETH", null], ["USDC", "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"]]);
  });

  it("uses chain data from the API when it is there", () => {
    const out = sourceChains([{ ...chains[2]!, chainId: 4663, rpcUrls: ["https://rpc.example"], nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 } }]);
    expect(out[0]!.add).toEqual({ chainId: "0x1237", chainName: "Robinhood Chain", nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: ["https://rpc.example"] });
  });

  it("never sends more than typed; checks the deposit address and the memo", () => {
    expect(auroraSendAmount(100n, null)).toBe(100n);
    expect(auroraSendAmount(100n, "99")).toBe(99n);
    expect(auroraSendAmount(100n, "25.5")).toBe(100n);
    expect(() => auroraSendAmount(100n, "101")).toThrow(/more than you entered/);
    expect(checkAuroraDestination({ depositAddress: TO, depositMemo: null })).toBe(getAddress(TO));
    expect(() => checkAuroraDestination({ depositAddress: null, depositMemo: null })).toThrow(/no valid deposit address/);
    expect(() => checkAuroraDestination({ depositAddress: TO, depositMemo: "123" })).toThrow(/memo/);
  });
});

describe("web provider filter", () => {
  // The web module, imported by path: Jest runs with the native platform.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { isPlainMetaMask } = require("../src/lib/metamask/provider.web") as typeof import("../src/lib/metamask/provider.web");
  const request = async () => null;
  it("accepts MetaMask only", () => {
    expect(isPlainMetaMask({ isMetaMask: true, request })).toBe(true);
    expect(isPlainMetaMask({ isMetaMask: true, isBraveWallet: true, request })).toBe(false);
    expect(isPlainMetaMask({ isMetaMask: true, isRabby: true, request })).toBe(false);
    expect(isPlainMetaMask({ isCoinbaseWallet: true, request })).toBe(false);
    expect(isPlainMetaMask({ isMetaMask: true })).toBe(false);
    expect(isPlainMetaMask(null)).toBe(false);
  });
});
