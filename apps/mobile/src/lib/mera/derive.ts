/**
 * PRF output → EVM account, as the Mera "Create passkey accounts" recipe documents it
 * (https://mera.category.xyz/recipes/create-passkey-accounts/):
 *
 *   32-byte PRF output (the BIP-39 entropy) → 24-word mnemonic → BIP-39 seed (no passphrase)
 *   → BIP-32 m/44'/60'/0'/0/0 → secp256k1 private key → Mera signing session.
 *
 * Every step is deterministic. The same passkey on a new device gives the same PRF output (fixed Mera salt
 * sha256("mera.prf.salt.v1")), so it gives the same address. The standard path also means a user can export
 * the 24 words to any wallet later.
 */
import { createSecp256k1SigningSession, getEvmAddress, type EvmAddress, type Secp256k1SigningSession } from "@category-labs/mera";
import { HDKey } from "@scure/bip32";
import { entropyToMnemonic, mnemonicToSeed } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english.js";

export const EVM_PATH = "m/44'/60'/0'/0/0";

export interface DerivedAccount {
  session: Secp256k1SigningSession;
  address: EvmAddress;
}

/**
 * Derive the signing session from the PRF output. The PRF output, the seed and the private key copy are zeroed
 * before the function returns; only the session holds the key. (The mnemonic is a JS string and cannot be zeroed.
 * It leaves scope here and is never stored.)
 */
export async function deriveAccount(prfOutput: Uint8Array): Promise<DerivedAccount> {
  if (prfOutput.length !== 32) throw new Error("The passkey returned a PRF output that is not 32 bytes.");
  let seed: Uint8Array | undefined;
  let node: HDKey | undefined;
  try {
    // mnemonicToSeed is the async PBKDF2 (2048 rounds). It yields to the UI thread, unlike mnemonicToSeedSync.
    seed = await mnemonicToSeed(entropyToMnemonic(prfOutput, wordlist));
    node = HDKey.fromMasterSeed(seed).derive(EVM_PATH);
    if (!node.privateKey) throw new Error("The key derivation produced no key.");
    const session = createSecp256k1SigningSession({ privateKey: node.privateKey });
    return { session, address: getEvmAddress(session.publicKey) };
  } finally {
    prfOutput.fill(0);
    seed?.fill(0);
    node?.wipePrivateData();
  }
}
