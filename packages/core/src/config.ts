import { z } from "zod";

const Env = z.object({
  // OpenAI. The key stays in the API process. It never reaches the browser or the agent terminal.
  OPENAI_API_KEY: z.string().optional(),
  /** Optional. Sends the OpenAI-Project header for a key that is not scoped to one project. */
  OPENAI_PROJECT: z.string().optional(),
  OPENAI_MODEL: z.string().default("gpt-6-astra"),
  /** The small model for the guard supervisor and the memory review. */
  OPENAI_GUARD_MODEL: z.string().default("gpt-5.6-luna"),
  // Reasoning effort of the chat agent. Higher is slower and costs more, and it finds more.
  OPENAI_EFFORT: z.enum(["low", "medium", "high", "xhigh", "max"]).default("medium"),

  // Deepgram voice: speech to text and text to speech (https://console.deepgram.com). Server only.
  DEEPGRAM_API_KEY: z.string().optional(),
  DEEPGRAM_STT_MODEL: z.string().default("nova-3"),
  DEEPGRAM_TTS_MODEL: z.string().default("aura-2-thalia-en"),

  // Aurora Intents: deposits from any chain to Monad (https://studio.aurora.dev). The key is not secret; Aurora puts it in URLs.
  AURORA_API_KEY: z.string().optional(),

  // Nansen: the risk layer of every Perpl order (https://app.nansen.ai/auth/agent-setup). Without it, orders get the conservative default.
  NANSEN_API_KEY: z.string().optional(),
  /** Credits one pre-trade check may spend. */
  NANSEN_MAX_CREDITS: z.coerce.number().default(15),

  // Privy sign-in. The app id is public. The app secret stays on the server.
  PRIVY_APP_ID: z.string().optional(),
  PRIVY_APP_SECRET: z.string().optional(),
  PRIVY_VERIFICATION_KEY: z.string().optional(),
  // Server signer for the Privy wallet of a user (key quorum id and its P-256 private key). The deposit converter uses it.
  PRIVY_SIGNER_ID: z.string().optional(),
  PRIVY_AUTHORIZATION_KEY: z.string().optional(),
  PUBLIC_APP_URL: z.string().default("http://localhost:3000"),
  // Gas sponsor (EIP-7702). One key, the same address on every EVM chain. It sends the transactions of the users and pays the gas.
  SPONSOR_PRIVATE_KEY: z.string().optional(),
  SPONSOR_DAILY_TXS: z.coerce.number().default(200),
  // Scheduled jobs: how often the server reads the conditions.
  JOB_INTERVAL_SECONDS: z.coerce.number().default(15),

  DATABASE_URL: z.string().default("postgres://localhost:5432/mona_dfi"),
  API_PORT: z.coerce.number().default(8787),
  WORKSPACES_DIR: z.string().default("./workspaces"),


  // Pricing. All amounts are USD.
  // Prompts, actions and guard time are free for now. The model cost is still measured and stored.
  PRICE_PROMPT_USD: z.coerce.number().default(0),
  PRICE_ACTION_USD: z.coerce.number().default(0),
  PRICE_GUARD_MINUTE_USD: z.coerce.number().default(0),
  USER_DAILY_LLM_BUDGET_USD: z.coerce.number().default(50),
  USER_PROMPTS_PER_MINUTE: z.coerce.number().default(10),

  // RPC endpoints. Public defaults work for reads. Use paid endpoints for execution.
  RPC_ETHEREUM: z.string().default("https://ethereum-rpc.publicnode.com"),
  RPC_ARBITRUM: z.string().default("https://arb1.arbitrum.io/rpc"),
  // The publicnode endpoint refuses a gas estimate for a sponsored transaction ("archive request"). The official endpoints accept it.
  RPC_BASE: z.string().default("https://mainnet.base.org"),
  RPC_MONAD: z.string().default("https://rpc.monad.xyz"),
  RPC_POLYGON: z.string().default("https://polygon-bor-rpc.publicnode.com"),

  // Signers held by the API and guard processes only.
  KEY_ENCRYPTION_SECRET: z.string().optional(),
});

export type Config = z.infer<typeof Env>;

let cached: Config | undefined;
export function config(): Config {
  // An empty value in .env means "not set". The default then applies.
  cached ??= Env.parse(Object.fromEntries(Object.entries(process.env).filter(([, v]) => v !== "")));
  return cached;
}
