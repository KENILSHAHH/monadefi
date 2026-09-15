// The workspace tools of the agent: a terminal in the OS sandbox, file tools, a web reader and the product skills.
// The terminal runs each command through the sandbox runtime (sandbox-exec on macOS, bubblewrap on Linux) with a network allowlist.
// Writes stay inside the workspace of the user. The code and secrets of the server and other workspaces cannot be read.
// The file tools run in the API process, so they check the path themselves.
import { spawn } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SandboxManager, type SandboxRuntimeConfig } from "@anthropic-ai/sandbox-runtime";
import { z } from "zod";
import { config } from "../config";
import { CHAINS } from "../registry/chains";
import { tool, type AgentTool } from "./tool";

export const REPO_ROOT = path.resolve(fileURLToPath(new URL("../../../../", import.meta.url)));
const SKILLS_DIR = path.join(REPO_ROOT, "skills");

/**
 * Hosts the agent terminal can reach from inside the sandbox: the APIs of the supported apps.
 * Every other host stays blocked, so a script cannot send data to an address of its choice.
 */
const TERMINAL_API_HOSTS = [
  // Perpl (perps on Monad) and Monad
  "perpl.xyz", "app.perpl.xyz", "api.perpl.xyz", "docs.perpl.xyz", "docs.monad.xyz", "monadscan.com", "api.monadscan.com", "monadvision.com",
  // Market intelligence and deposits into Monad
  "api.nansen.ai", "intents-api.aurora.dev", "intents-connect-api.aurora.dev", "1click.chaindefuser.com",
  // Bridges and swaps into and on Monad
  "api.relay.link", "li.quest",
  // Price APIs
  "api.coingecko.com", "hermes.pyth.network", "coins.llama.fi",
  // Contract sources and verification
  "sourcify.dev", "repo.sourcify.dev",
  // What the agent needs to build and test code: packages, compilers, source code
  "github.com", "api.github.com", "raw.githubusercontent.com", "codeload.github.com", "objects.githubusercontent.com",
  "registry.npmjs.org", "pypi.org", "files.pythonhosted.org", "crates.io", "static.crates.io", "binaries.soliditylang.org", "foundry.paradigm.xyz",
];

/** The API hosts plus the RPC host of each chain, so a script and a local fork (anvil) can read the chains. */
function terminalAllowedDomains(): string[] {
  const rpcs = Object.values(CHAINS).flatMap((c) => {
    try {
      return [new URL(c.rpc()).hostname];
    } catch {
      return [];
    }
  });
  return [...new Set([...TERMINAL_API_HOSTS, ...rpcs])];
}

/** Tool folders inside a home directory that the terminal must still read: Foundry and Node. */
const TOOLCHAIN_DIRS = [path.join(process.env.HOME ?? "/home/defi", ".foundry"), path.join(process.env.HOME ?? "/home/defi", ".nvm"), path.join(process.env.HOME ?? "/home/defi", ".svm")];

/** One directory per user. The skills are copied in, so a script can read them too. */
export function workspaceFor(userId: string): { base: string; cwd: string; home: string } {
  const base = path.resolve(config().WORKSPACES_DIR, userId.toLowerCase().replace(/[^a-z0-9]/g, ""));
  const cwd = path.join(base, "work");
  const home = path.join(base, "home");
  mkdirSync(home, { recursive: true });
  mkdirSync(cwd, { recursive: true });
  const skills = path.join(cwd, "skills");
  if (!existsSync(skills)) cpSync(SKILLS_DIR, skills, { recursive: true });
  return { base, cwd, home };
}

// ── Skills ─────────────────────────────────────────────────────────────────

export interface Skill { name: string; description: string }

/** The product skills: <repo>/skills/<name>/SKILL.md with a name and a description in the front matter. */
export const SKILLS: Skill[] = readdirSync(SKILLS_DIR, { withFileTypes: true }).filter((d) => d.isDirectory() && existsSync(path.join(SKILLS_DIR, d.name, "SKILL.md"))).map((d) => {
  const text = readFileSync(path.join(SKILLS_DIR, d.name, "SKILL.md"), "utf8");
  const description = /^description:\s*(.+)$/m.exec(text)?.[1]?.trim() ?? "";
  return { name: d.name, description };
});

/** The list that goes into the system prompt. It is constant, so the prompt cache prefix stays stable. */
export const SKILLS_INDEX = SKILLS.map((s) => `- ${s.name}: ${s.description}`).join("\n");

// ── Sandbox ────────────────────────────────────────────────────────────────

/**
 * Linux: the sandbox runs a small seccomp helper. Its default path is inside node_modules of this repo, which the terminal may not
 * read, so a server installs a copy outside the repo (SANDBOX_SECCOMP_PATH, default /usr/local/lib/mona-dfi/apply-seccomp).
 */
const SECCOMP_PATH = process.env.SANDBOX_SECCOMP_PATH || "/usr/local/lib/mona-dfi/apply-seccomp";
const seccomp = () => (process.platform === "linux" && existsSync(SECCOMP_PATH) ? { seccomp: { applyPath: SECCOMP_PATH } } : {});

let sandboxReady: Promise<boolean> | null = null;
function initSandbox(): Promise<boolean> {
  sandboxReady ??= (async () => {
    if (!SandboxManager.isSupportedPlatform()) return false;
    const cfg: SandboxRuntimeConfig = {
      network: { allowedDomains: terminalAllowedDomains(), deniedDomains: [], allowLocalBinding: true },
      filesystem: { denyRead: ["/home", "/root", "/Users"], allowWrite: [], denyWrite: [] },
      ...seccomp(),
    } as SandboxRuntimeConfig;
    await SandboxManager.initialize(cfg);
    return true;
  })().catch((err) => {
    console.error("sandbox: not available:", err instanceof Error ? err.message : err);
    return false;
  });
  return sandboxReady;
}

const MAX_OUTPUT = 30_000;
const cut = (s: string) => (s.length > MAX_OUTPUT ? `${s.slice(0, MAX_OUTPUT / 2)}\n… (${s.length - MAX_OUTPUT} characters cut) …\n${s.slice(-MAX_OUTPUT / 2)}` : s);

/** Run one command in the sandbox. It never runs a command outside the sandbox. */
async function runSandboxed(ws: { base: string; cwd: string; home: string }, command: string, timeoutMs: number, signal?: AbortSignal): Promise<{ code: number | null; output: string }> {
  if (!(await initSandbox())) throw new Error("The terminal sandbox is not available on this server, so the terminal is off. Use the typed tools.");
  const custom = {
    filesystem: {
      denyRead: [REPO_ROOT, path.resolve(config().WORKSPACES_DIR), "/home", "/root", "/Users", "/etc/caddy"],
      allowRead: [ws.base, ...TOOLCHAIN_DIRS],
      allowWrite: [ws.base],
      denyWrite: [],
    },
    ...seccomp(),
  } as Partial<SandboxRuntimeConfig>;
  const wrapped = await SandboxManager.wrapWithSandbox(command, undefined, custom, signal);
  return new Promise((resolve) => {
    // The environment holds no secret: only the path, a home inside the workspace and the language.
    const child = spawn(wrapped, { shell: true, cwd: ws.cwd, env: { PATH: process.env.PATH, HOME: ws.home, LANG: process.env.LANG ?? "en_US.UTF-8" } });
    let out = "";
    const add = (b: Buffer) => {
      out += b.toString();
      if (out.length > MAX_OUTPUT * 4) out = out.slice(-MAX_OUTPUT * 2);
    };
    child.stdout.on("data", add);
    child.stderr.on("data", add);
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    const stop = () => child.kill("SIGKILL");
    signal?.addEventListener("abort", stop, { once: true });
    child.on("close", (code) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", stop);
      SandboxManager.cleanupAfterCommand();
      resolve({ code, output: cut(SandboxManager.annotateStderrWithSandboxFailures(command, out)) });
    });
  });
}

// ── Web reader ─────────────────────────────────────────────────────────────

const PRIVATE_V4 = [/^10\./, /^127\./, /^0\./, /^169\.254\./, /^192\.168\./, /^172\.(1[6-9]|2\d|3[01])\./, /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./];
const isPrivate = (ip: string) => (isIP(ip) === 6 ? /^(::1|fc|fd|fe80|::ffff:(10|127|192\.168|169\.254)\.)/i.test(ip) : PRIVATE_V4.some((r) => r.test(ip)));

/** Read a public web page as text. Only https, only public addresses, so the server network is not reachable. */
async function webFetch(url: string): Promise<string> {
  const u = new URL(url);
  if (u.protocol !== "https:") throw new Error("Only https URLs can be read.");
  const addrs = await lookup(u.hostname, { all: true });
  if (addrs.length === 0 || addrs.some((a) => isPrivate(a.address))) throw new Error("That host is not a public address.");
  const res = await fetch(u, { redirect: "manual", signal: AbortSignal.timeout(20_000), headers: { "user-agent": "Mozilla/5.0 (compatible; MonaDeFiAgent/1.0)", accept: "text/html,application/json,text/plain,*/*" } });
  if (res.status >= 300 && res.status < 400) return `Redirect (${res.status}) to ${res.headers.get("location")}. Fetch that URL if you trust it.`;
  const type = res.headers.get("content-type") ?? "";
  let text = await res.text();
  if (type.includes("html")) {
    text = text.replace(/<script[\s\S]*?<\/script>/gi, "").replace(/<style[\s\S]*?<\/style>/gi, "").replace(/<br\s*\/?>|<\/(p|div|h\d|li|tr|pre)>/gi, "\n").replace(/<[^>]+>/g, "").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/\n\s*\n+/g, "\n\n");
  }
  return `HTTP ${res.status} ${type}\n\n${text.length > 60_000 ? `${text.slice(0, 60_000)}… (cut)` : text}`;
}

// ── Tools ──────────────────────────────────────────────────────────────────

const ok = (text: string) => ({ content: [{ type: "text" as const, text }] });

export function workspaceTools(userId: string, signal?: AbortSignal): AgentTool[] {
  const ws = workspaceFor(userId);
  /** A path inside the workspace of the user, or an error. */
  const inside = (p: string) => {
    const full = path.resolve(ws.cwd, p);
    if (full !== ws.base && !full.startsWith(ws.base + path.sep)) throw new Error("Files outside your workspace are not available. Work inside the current directory.");
    return full;
  };
  return [
    tool("bash", "Run a shell command in your workspace terminal (bash). Foundry (forge, cast, anvil), Node and Python are installed. Network: only the supported app APIs and the chain RPCs. No private key exists here. The product skills are in ./skills. Output is cut at 30,000 characters.",
      { command: z.string().min(1), timeoutSeconds: z.number().int().min(1).max(600).default(120) },
      async ({ command, timeoutSeconds }) => {
        const r = await runSandboxed(ws, command, timeoutSeconds * 1000, signal);
        return { content: [{ type: "text", text: `exit code ${r.code ?? "killed (timeout)"}\n${r.output}` }], isError: r.code !== 0 };
      }),

    tool("read_file", "Read a text file in your workspace, with line numbers.",
      { path: z.string(), offset: z.number().int().min(1).default(1), limit: z.number().int().min(1).max(5000).default(2000) },
      async (a) => {
        const lines = readFileSync(inside(a.path), "utf8").split("\n");
        return ok(lines.slice(a.offset - 1, a.offset - 1 + a.limit).map((l, i) => `${a.offset + i}\t${l}`).join("\n"));
      }, { annotations: { readOnlyHint: true } }),

    tool("write_file", "Create or replace a file in your workspace.",
      { path: z.string(), content: z.string() },
      async (a) => {
        const full = inside(a.path);
        mkdirSync(path.dirname(full), { recursive: true });
        writeFileSync(full, a.content);
        return ok(`Wrote ${a.content.length} characters to ${path.relative(ws.cwd, full)}.`);
      }),

    tool("edit_file", "Replace an exact text in a file of your workspace. oldText must appear exactly once, unless replaceAll is true.",
      { path: z.string(), oldText: z.string().min(1), newText: z.string(), replaceAll: z.boolean().default(false) },
      async (a) => {
        const full = inside(a.path);
        const text = readFileSync(full, "utf8");
        const count = text.split(a.oldText).length - 1;
        if (count === 0) throw new Error("oldText is not in the file.");
        if (count > 1 && !a.replaceAll) throw new Error(`oldText appears ${count} times. Give more context or set replaceAll.`);
        writeFileSync(full, a.replaceAll ? text.split(a.oldText).join(a.newText) : text.replace(a.oldText, () => a.newText));
        return ok(`Replaced ${a.replaceAll ? count : 1} occurrence(s).`);
      }),

    tool("web_fetch", "Read a public web page or JSON API by https URL, as text. Use it for docs, explorers and APIs that the terminal cannot reach.",
      { url: z.string().url() }, async ({ url }) => ok(await webFetch(url)), { annotations: { readOnlyHint: true } }),

    tool("load_skill", `Load a product skill: verified facts, addresses, endpoints and risks of a protocol. Load the matching skill before you answer a protocol question or call an action tool for it. Skills: ${SKILLS.map((s) => s.name).join(", ")}.`,
      { name: z.enum(SKILLS.map((s) => s.name) as [string, ...string[]]) },
      async ({ name }) => ok(readFileSync(path.join(SKILLS_DIR, name, "SKILL.md"), "utf8")), { annotations: { readOnlyHint: true } }),
  ];
}
