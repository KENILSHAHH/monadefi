// Mera accounts and their scoped sessions on Monad.
//
// A Mera user signs in with a passkey. The passkey gives a normal EOA; its address is the user id. The server never holds its key.
// The agent acts for the user only through a session: delegations from the Mera wallet (an EIP-7702 MetaMask smart account) to the
// agent key of the user (a server key that holds no funds). The delegations allow exactly:
//   - Perpl Exchange: place, change and cancel orders, add margin, ask to remove margin, deposit, open the account;
//   - AUSD: approve, with the Perpl Exchange as the only spender (AllowedCalldataEnforcer pins the spender).
// They do not allow withdrawCollateral, transfers or any other contract, so the server can trade but cannot move funds out.
// The DelegationManager checks every call on-chain, so the stored delegations are untrusted storage: the phone can sign them again.
// Docs: https://docs.metamask.io/smart-accounts-kit/ and https://docs.monad.xyz/developer-essentials/eip-7702
import { randomBytes } from "node:crypto";
import { createDelegation, createExecution, ExecutionMode, getSmartAccountsEnvironment, ScopeType } from "@metamask/smart-accounts-kit";
import { DelegationManager } from "@metamask/smart-accounts-kit/contracts";
import { createCaveatBuilder, hashDelegation, SIGNABLE_DELEGATION_TYPED_DATA } from "@metamask/smart-accounts-kit/utils";
import { createWalletClient, encodeFunctionData, http, pad, parseAbi, recoverMessageAddress, recoverTypedDataAddress, toFunctionSelector, type Address, type Hex, type SignedAuthorization } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { AUSD, PERPL_EXCHANGE } from "./adapters/perpl";
import type { EvmTx } from "./adapters/evm";
import { config } from "./config";
import { signToken, verifyToken } from "./crypto";
import { ensureUser, sql } from "./db";
import { CHAINS } from "./registry/chains";
import { getOrCreateWallet, legacyAccount, publicClient, viemChain } from "./wallet";

export { isMeraUser } from "./wallet";

const CHAIN = "monad" as const;
const env = () => getSmartAccountsEnvironment(CHAINS.monad.chainId!);
const manager = () => env().DelegationManager as Address;
export const implementation = () => (env().implementations as Record<string, string>).EIP7702StatelessDeleGatorImpl as Address;

/** What the session lets the agent do on the Perpl Exchange. No withdrawCollateral, no allowOrderForwarding. */
export const PERPL_SESSION_FUNCTIONS = [
  "execOrder((uint256,uint256,uint8,uint256,uint256,uint256,uint256,bool,bool,bool,uint256,uint256,uint256,uint256,uint256))",
  "execOrders((uint256,uint256,uint8,uint256,uint256,uint256,uint256,bool,bool,bool,uint256,uint256,uint256,uint256,uint256)[],bool)",
  "increasePositionCollateral(uint256,uint256)",
  "requestDecreasePositionCollateral(uint256,uint256,bool)",
  "cancelDecreaseCollateralRequest(uint256)",
  "depositCollateral(uint256)",
  "createAccount(uint256)",
] as const;
const APPROVE = "approve(address,uint256)";
const MAX_DAYS = 90;

export type SessionKind = "perpl_trade" | "ausd_approve";

interface StoredDelegation { delegate: Address; delegator: Address; authority: Hex; caveats: { enforcer: Address; terms: Hex; args: Hex }[]; salt: Hex }
interface Row { id: string; user_id: string; owner: string; kind: SessionKind; delegation: StoredDelegation; signature: string | null; status: string; expires_at: Date; created_at: Date }

// ── Mera sign-in ─────────────────────────────────────────────────────────────
const SIGN_IN_TEXT = (address: string, nonce: string) => `Sign in to Mona-DeFi on Monad.\n\nAddress: ${address}\nNonce: ${nonce}\n\nThis signature does not move funds.`;

export function meraChallenge(address: string) {
  const a = address.toLowerCase();
  const nonce = signToken({ address: a, aud: "mera-nonce" }, 300);
  return { nonce, message: SIGN_IN_TEXT(a, nonce) };
}

/** Check the signature of the Mera wallet. The user id is the wallet address. Returns the session token. */
export async function meraVerify(args: { address: string; nonce: string; signature: string }) {
  const a = args.address.toLowerCase();
  const claims = verifyToken<{ address: string; aud: string }>(args.nonce);
  if (!claims || claims.aud !== "mera-nonce" || claims.address !== a) throw new Error("The sign-in request is invalid or expired.");
  const signer = await recoverMessageAddress({ message: SIGN_IN_TEXT(a, args.nonce), signature: args.signature as Hex });
  if (signer.toLowerCase() !== a) throw new Error("The signature does not match the address.");
  await ensureUser(a);
  await sql()`update users set auth_kind = 'mera' where id = ${a}`;
  const wallet = await getOrCreateWallet(a);
  return { token: signToken({ sub: a, aud: "session" }, 30 * 86_400), address: a, agentAddress: wallet.legacyAddress };
}

// ── EIP-7702 upgrade ─────────────────────────────────────────────────────────
export async function isUpgraded(owner: string): Promise<boolean> {
  const code = await publicClient(CHAIN).getCode({ address: owner as Address });
  return code?.toLowerCase() === `0xef0100${implementation().slice(2).toLowerCase()}`;
}

/** The phone signs the authorization (no prompt: the Mera signing session signs it). The gas sponsor sends it. */
export async function relayUpgrade(userId: string, authorization: SignedAuthorization) {
  if (!config().SPONSOR_PRIVATE_KEY) throw new Error("The gas sponsor is not set up on this server.");
  if (authorization.chainId !== CHAINS.monad.chainId) throw new Error("The authorization must be for Monad (chain 143).");
  if (authorization.address.toLowerCase() !== implementation().toLowerCase()) throw new Error(`The authorization must name the MetaMask smart account ${implementation()}.`);
  const relayer = createWalletClient({ account: privateKeyToAccount(config().SPONSOR_PRIVATE_KEY as Hex), chain: viemChain(CHAIN), transport: http() });
  const hash = await relayer.sendTransaction({ authorizationList: [authorization], to: userId as Address, data: "0x" });
  const r = await publicClient(CHAIN).waitForTransactionReceipt({ hash, timeout: 120_000 });
  if (r.status !== "success") throw new Error(`The upgrade ${hash} reverted.`);
  if (!(await isUpgraded(userId))) throw new Error("The upgrade landed but the wallet code is not the smart account. Was the authorization signed by this wallet with its current nonce?");
  return { hash, explorer: `${CHAINS.monad.explorer}/tx/${hash}` };
}

// ── Session delegations ──────────────────────────────────────────────────────
function typedData(d: StoredDelegation) {
  return {
    domain: { name: "DelegationManager", version: "1", chainId: CHAINS.monad.chainId!, verifyingContract: manager() },
    types: { ...SIGNABLE_DELEGATION_TYPED_DATA },
    primaryType: "Delegation" as const,
    message: { delegate: d.delegate, delegator: d.delegator, authority: d.authority, caveats: d.caveats.map((c) => ({ enforcer: c.enforcer, terms: c.terms })), salt: BigInt(d.salt).toString() },
  };
}

/** The typed data with the EIP712Domain type, as eth_signTypedData_v4 and viem signTypedData take it. */
function signable(d: StoredDelegation) {
  const t = typedData(d);
  return { ...t, types: { EIP712Domain: [{ name: "name", type: "string" }, { name: "version", type: "string" }, { name: "chainId", type: "uint256" }, { name: "verifyingContract", type: "address" }], ...t.types } };
}

function build(kind: SessionKind, owner: Address, agent: Address, expires: number): StoredDelegation {
  const timestamp = { type: "timestamp", afterThreshold: 0, beforeThreshold: expires };
  const d = (kind === "perpl_trade"
    ? createDelegation({ from: owner, to: agent, environment: env(), scope: { type: ScopeType.FunctionCall, targets: [PERPL_EXCHANGE], selectors: [...PERPL_SESSION_FUNCTIONS], valueLte: { maxValue: 0n } }, caveats: [timestamp] } as never)
    : createDelegation({
      from: owner, to: agent, environment: env(),
      scope: { type: ScopeType.FunctionCall, targets: [AUSD.address], selectors: [APPROVE], valueLte: { maxValue: 0n } },
      // Bytes 4 to 36 of the call are the spender. Only the Perpl Exchange can get an allowance.
      caveats: [timestamp, { type: "allowedCalldata", startIndex: 4, value: pad(PERPL_EXCHANGE, { size: 32 }) }],
    } as never)) as unknown as StoredDelegation;
  return { delegate: d.delegate, delegator: d.delegator, authority: d.authority, caveats: d.caveats, salt: `0x${randomBytes(16).toString("hex")}` };
}

export interface SessionPermission { id: string; kind: SessionKind; status: "pending" | "active" | "expired"; expiresAt: string }

const toPermission = (r: Row): SessionPermission => ({ id: r.id, kind: r.kind, status: r.status === "active" && r.expires_at.getTime() < Date.now() ? "expired" : (r.status as "pending" | "active"), expiresAt: r.expires_at.toISOString() });

const rows = (userId: string) => sql()<Row[]>`select * from mera_sessions where user_id = ${userId} and status in ('pending', 'active') order by created_at desc`;

/** The state the app needs to decide its next step. */
export async function sessionStatus(userId: string) {
  const [wallet, upgraded, list] = await Promise.all([getOrCreateWallet(userId), isUpgraded(userId), rows(userId)]);
  const live = list.filter((r) => r.expires_at.getTime() > Date.now());
  const active = (k: SessionKind) => live.some((r) => r.kind === k && r.status === "active" && r.signature);
  const status = !upgraded ? "needs_upgrade" : active("perpl_trade") && active("ausd_approve") ? "active" : list.length && !live.length ? "expired" : live.length ? "needs_signature" : "none";
  return {
    status, address: userId, agentAddress: wallet.legacyAddress, upgraded, implementation: implementation(), chainId: CHAINS.monad.chainId!,
    permissions: list.map(toPermission),
    scope: { targets: [PERPL_EXCHANGE, AUSD.address], functions: [...PERPL_SESSION_FUNCTIONS.map((f) => f.split("(")[0]!), "approve (spender: Perpl Exchange only)"], cannot: ["withdraw from Perpl", "transfer any token", "call any other contract", "send MON"] },
  };
}

/** Create the two session delegations for the phone to sign. Older pending ones are replaced. */
export async function startSession(userId: string, days = 30) {
  const d = Math.min(Math.max(Math.round(days), 1), MAX_DAYS);
  const expires = Math.floor(Date.now() / 1000) + d * 86_400;
  const agent = (await getOrCreateWallet(userId)).legacyAddress;
  await sql()`update mera_sessions set status = 'replaced', signature = null where user_id = ${userId} and status = 'pending'`;
  const out = [];
  for (const kind of ["perpl_trade", "ausd_approve"] as const) {
    const delegation = build(kind, userId as Address, agent, expires);
    const id = `sess_${randomBytes(8).toString("hex")}`;
    await sql()`insert into mera_sessions (id, user_id, owner, kind, delegation, expires_at) values (${id}, ${userId}, ${userId}, ${kind}, ${sql().json(delegation as never)}, ${new Date(expires * 1000)})`;
    out.push({ id, kind, typedData: signable(delegation) });
  }
  return { permissions: out, expiresAt: new Date(expires * 1000).toISOString() };
}

/** Store a signature after checking that the Mera wallet signed exactly this delegation. */
export async function grantSession(userId: string, id: string, signature: string): Promise<SessionPermission> {
  const [r] = await sql()<Row[]>`select * from mera_sessions where id = ${id} and user_id = ${userId}`;
  if (!r || r.status !== "pending") throw new Error("This session permission is not pending.");
  const t = typedData(r.delegation);
  const signer = await recoverTypedDataAddress({ ...t, message: { ...t.message, salt: BigInt(t.message.salt) }, signature: signature as Hex } as never);
  if (signer.toLowerCase() !== userId) throw new Error("The signature is not from your wallet.");
  // A newer session of the same kind replaces the active one.
  await sql()`update mera_sessions set status = 'replaced', signature = null where user_id = ${userId} and kind = ${r.kind} and status = 'active'`;
  const [row] = await sql()<Row[]>`update mera_sessions set status = 'active', signature = ${signature} where id = ${id} and status = 'pending' returning *`;
  return toPermission(row!);
}

const disableAbi = parseAbi(["function disableDelegation((address delegate, address delegator, bytes32 authority, (address enforcer, bytes terms, bytes args)[] caveats, uint256 salt, bytes signature) delegation)"]);

/**
 * Revoke: the server deletes the signatures at once. The delegations stay valid on-chain until they end, so the result also holds the
 * DelegationManager.disableDelegation calls; the phone sends them through the relay (the wallet itself must call it).
 */
export async function revokeSession(userId: string) {
  const live = await sql()<Row[]>`select * from mera_sessions where user_id = ${userId} and status = 'active' and signature is not null and expires_at > now()`;
  const calls = live.map((r) => ({
    to: manager(), value: "0", description: `Cancel the ${r.kind === "perpl_trade" ? "Perpl trading" : "AUSD approval"} permission on-chain`,
    data: encodeFunctionData({ abi: disableAbi, functionName: "disableDelegation", args: [{ delegate: r.delegation.delegate, delegator: r.delegation.delegator, authority: r.delegation.authority, caveats: r.delegation.caveats.map((c) => ({ enforcer: c.enforcer, terms: c.terms, args: c.args ?? "0x" })), salt: BigInt(r.delegation.salt), signature: r.signature as Hex }] }),
  }));
  const n = await sql()`update mera_sessions set status = 'revoked', signature = null where user_id = ${userId} and status in ('pending', 'active') returning id`;
  return { revoked: n.length > 0, calls };
}

/** The active session delegation that covers each call. A call outside the session scope is refused with a plain reason. */
async function sessionRowsFor(userId: string, txs: EvmTx[]): Promise<Row[]> {
  const live = (await rows(userId)).filter((r) => r.status === "active" && r.signature && r.expires_at.getTime() > Date.now());
  if (!live.length) throw new Error("Trading is not turned on for this wallet, or the session ended. Open the app and turn on trading (one tap, no fee).");
  const perplSelectors = new Set(PERPL_SESSION_FUNCTIONS.map((f) => toFunctionSelector(f).toLowerCase()));
  return txs.map((tx, i) => {
    if (!tx.to) throw new Error("A session cannot deploy a contract.");
    if (BigInt(tx.value) > 0n) throw new Error("A session cannot send MON.");
    const to = tx.to.toLowerCase();
    const selector = tx.data.slice(0, 10).toLowerCase();
    let kind: SessionKind | null = null;
    if (to === PERPL_EXCHANGE.toLowerCase() && perplSelectors.has(selector)) kind = "perpl_trade";
    else if (to === AUSD.address.toLowerCase() && selector === toFunctionSelector(APPROVE) && tx.data.slice(34, 74).toLowerCase() === PERPL_EXCHANGE.slice(2).toLowerCase()) kind = "ausd_approve";
    const r = kind && live.find((x) => x.kind === kind);
    if (!r) throw new Error(`Step ${i + 1} ("${tx.description}") is outside the trading session: it only covers Perpl orders, margin and deposits. Do it in the app.`);
    return r;
  });
}

/**
 * Wrap calls of the Mera wallet into redeemDelegations calls that the agent key makes itself (it then pays its own gas).
 * Used only when no gas sponsor runs; with the sponsor, see sessionChainRedeem.
 */
export async function wrapSessionTransactions(userId: string, txs: EvmTx[]): Promise<EvmTx[]> {
  const picked = await sessionRowsFor(userId, txs);
  return txs.map((tx, i) => {
    const r = picked[i]!;
    const data = DelegationManager.encode.redeemDelegations({
      delegations: [[{ ...r.delegation, signature: r.signature as Hex }]],
      modes: [ExecutionMode.SingleDefault],
      executions: [[createExecution({ target: tx.to!, callData: tx.data, value: 0n })]],
    } as never);
    return { to: manager(), data, value: "0", description: tx.description };
  });
}

/**
 * One redeemDelegations call for the gas sponsor, with a delegation chain per call: [agent key -> sponsor, Mera wallet -> agent key].
 * The agent key signs a short sub-delegation (10 minutes) to the sponsor; it can never give more than the session gives.
 * Not nested: a redemption inside another redemption reverts in the DelegationManager, so the sponsor redeems the chain itself.
 */
export async function sessionChainRedeem(userId: string, txs: EvmTx[], sponsor: Address): Promise<{ to: Address; data: Hex }> {
  const picked = await sessionRowsFor(userId, txs);
  const agent = await legacyAccount(userId);
  const expires = Math.floor(Date.now() / 1000) + 600;
  const leaves = new Map<string, unknown>();
  const chainFor = async (r: Row) => {
    const root = { ...r.delegation, signature: r.signature as Hex };
    if (!leaves.has(r.id)) {
      const caveats = createCaveatBuilder(env()).addCaveat("timestamp", { afterThreshold: 0, beforeThreshold: expires }).build();
      const leaf = { delegate: sponsor, delegator: agent.address, authority: hashDelegation(root as never), caveats, salt: `0x${randomBytes(16).toString("hex")}` as Hex };
      const t = typedData(leaf as StoredDelegation);
      const signature = await agent.signTypedData({ ...t, message: { ...t.message, salt: BigInt(t.message.salt) } } as never);
      leaves.set(r.id, { ...leaf, signature });
    }
    return [leaves.get(r.id), root];
  };
  const delegations = [];
  for (const r of picked) delegations.push(await chainFor(r));
  const data = DelegationManager.encode.redeemDelegations({
    delegations,
    modes: txs.map(() => ExecutionMode.SingleDefault),
    executions: txs.map((tx) => [createExecution({ target: tx.to!, callData: tx.data, value: 0n })]),
  } as never);
  return { to: manager(), data };
}
