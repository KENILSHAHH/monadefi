import { toViemAccount } from "@category-labs/mera/viem";
import { entropyToMnemonic } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english.js";
import { mnemonicToAccount } from "viem/accounts";
import { recoverMessageAddress } from "viem";
import { deriveAccount, EVM_PATH } from "../src/lib/mera/derive";

const zeros = () => new Uint8Array(32);
const seq = () => Uint8Array.from({ length: 32 }, (_, i) => i);
const ff = () => new Uint8Array(32).fill(0xff);

// Pinned vectors. The zero vector is the well-known address of the 24-word "abandon … art" mnemonic at m/44'/60'/0'/0/0.
const VECTORS: [string, () => Uint8Array, string][] = [
  ["32 zero bytes", zeros, "0xF278cF59F82eDcf871d630F28EcC8056f25C1cdb"],
  ["bytes 0..31", seq, "0xF9297b542BDb5DA50C364f9AE4Cbe1F3933bA40F"],
  ["32 0xff bytes", ff, "0x1959f5f4979c5Cd87D5CB75c678c770515cb5E0E"],
];

describe("PRF output → EVM account (Mera recipe: BIP-39 entropy → BIP-32 m/44'/60'/0'/0/0)", () => {
  jest.setTimeout(30_000);

  it("uses the standard Ethereum path", () => {
    expect(EVM_PATH).toBe("m/44'/60'/0'/0/0");
  });

  it.each(VECTORS)("fixed PRF bytes (%s) give a fixed address", async (_name, prf, expected) => {
    const { session, address } = await deriveAccount(prf());
    expect(address).toBe(expected);
    session.end();
  });

  it("is deterministic: a fresh device with the same passkey gets the same address", async () => {
    const a = await deriveAccount(seq());
    const b = await deriveAccount(seq());
    expect(a.address).toBe(b.address);
    a.session.end();
    b.session.end();
  });

  it("matches an independent implementation (viem mnemonicToAccount on the same mnemonic)", async () => {
    for (const [, prf] of VECTORS) {
      const mnemonic = entropyToMnemonic(prf(), wordlist);
      const { session, address } = await deriveAccount(prf());
      expect(address).toBe(mnemonicToAccount(mnemonic).address);
      session.end();
    }
  });

  it("zeroes the PRF output it was given", async () => {
    const prf = seq();
    const { session } = await deriveAccount(prf);
    expect(Array.from(prf).every((b) => b === 0)).toBe(true);
    session.end();
  });

  it("rejects a PRF output that is not 32 bytes", async () => {
    await expect(deriveAccount(new Uint8Array(16))).rejects.toThrow(/32 bytes/);
  });

  it("signs through the viem adapter, and the signature recovers to the address", async () => {
    const { session, address } = await deriveAccount(zeros());
    const account = toViemAccount(session);
    const signature = await account.signMessage({ message: "Sign in to Mona-DeFi on Monad." });
    expect(await recoverMessageAddress({ message: "Sign in to Mona-DeFi on Monad.", signature })).toBe(address);
    session.end();
    await expect(account.signMessage({ message: "after end" })).rejects.toThrow();
  });
});
