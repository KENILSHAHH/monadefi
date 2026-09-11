create table if not exists users (
  id            text primary key,              -- lower-case EVM address of the owner: the Privy embedded wallet, or the wallet of an older sign-in
  created_at    timestamptz not null default now()
);
alter table users add column if not exists privy_did text unique;  -- Privy user id (did:privy:...)
-- The Privy wallet of the user is the wallet of the app.
alter table users add column if not exists deposit_wallet text;
alter table users add column if not exists privy_wallet_id text;
alter table users add column if not exists deposit_signer boolean not null default false;  -- the user added the server signer


create table if not exists intents (
  id          text primary key,
  user_id     text not null references users(id),
  kind        text not null,
  params      jsonb not null,
  preview     jsonb not null,
  intent_hash text not null,                    -- sha256 of kind + params
  status      text not null default 'pending',  -- pending | confirmed | executing | done | failed | rejected | expired
  fee_usd     numeric not null default 0,
  result      jsonb,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index if not exists intents_user on intents(user_id, created_at desc);

create table if not exists usage (
  id            bigserial primary key,
  user_id       text not null references users(id),
  session_id    text,
  model         text not null,
  input_tokens  bigint not null default 0,
  output_tokens bigint not null default 0,
  cache_read    bigint not null default 0,
  cache_write   bigint not null default 0,
  cost_usd      numeric not null,               -- model cost
  charged_usd   numeric not null,               -- price charged to the user (0 while prompts are free)
  created_at    timestamptz not null default now()
);
create index if not exists usage_user_day on usage(user_id, created_at);

create table if not exists charges (
  id          bigserial primary key,
  user_id     text not null references users(id),
  kind        text not null,                    -- prompt | action | guard
  amount_usd  numeric not null,
  reference   text,                             -- payment reference, when a payment exists
  detail      jsonb,
  created_at  timestamptz not null default now()
);

create table if not exists guards (
  id            text primary key,
  user_id       text not null references users(id),
  venue         text not null,                  -- perpl
  params        jsonb not null,                 -- asset, trigger, action, max slippage, gas budget
  status        text not null default 'active', -- active | triggered | done | cancelled | failed
  last_value    numeric,
  last_check    timestamptz,
  charged_until timestamptz not null default now(),
  created_at    timestamptz not null default now()
);

-- One row per guard firing. The primary key is the idempotency key, so two watchers cannot act twice.
create table if not exists guard_actions (
  idempotency_key text primary key,
  guard_id        text not null references guards(id),
  watcher         text not null,
  decision        jsonb not null,
  status          text not null default 'claimed', -- claimed | done | failed
  result          jsonb,
  created_at      timestamptz not null default now()
);

create table if not exists action_log (
  id           bigserial primary key,
  user_id      text not null references users(id),
  intent_id    text,
  intent_hash  text not null,
  chain        text not null,
  tx_hash      text not null,
  created_at   timestamptz not null default now()
);

-- One agent wallet per user. The server holds the key (encrypted). The user funds it and the agent acts from it.
create table if not exists agent_wallets (
  user_id        text primary key references users(id),
  evm_address    text not null unique,
  enc_key        text not null,
  auto_execute   boolean not null default true,   -- false = every action waits for a confirmation click
  max_action_usd numeric not null default 250,    -- hard limit per action
  created_at     timestamptz not null default now()
);

-- One row per transaction that the gas sponsor sent for a user (EIP-7702).
create table if not exists sponsored_txs (
  id           bigserial primary key,
  user_id      text not null references users(id),
  chain        text not null,
  hash         text not null,
  gas_cost_wei text not null,
  success      boolean not null,
  created_at   timestamptz not null default now()
);
create index if not exists sponsored_txs_user on sponsored_txs(user_id, created_at desc);

-- Scheduled jobs: a condition and a prepared action. The server fires the action when the condition is true.
create table if not exists jobs (
  id          text primary key,
  user_id     text not null references users(id),
  name        text not null,
  condition   jsonb not null,
  action      jsonb not null,
  status      text not null default 'active',   -- active | running | done | failed | cancelled | expired
  last_value  numeric,
  last_check  timestamptz,
  expires_at  timestamptz not null,
  result      jsonb,
  created_at  timestamptz not null default now()
);
create index if not exists jobs_active on jobs(status) where status = 'active';
create index if not exists jobs_user on jobs(user_id, created_at desc);

-- The limit for one action was 250 USD for every wallet. The product no longer limits the agent by default.
alter table agent_wallets alter column max_action_usd set default 1000000;
update agent_wallets set max_action_usd = 1000000 where max_action_usd = 250;

-- A repeated job: it waits repeat_seconds after each run, until it ran repeat_times times.
alter table jobs add column if not exists repeat_seconds integer;
alter table jobs add column if not exists repeat_times integer;
alter table jobs add column if not exists runs_done integer not null default 0;
alter table jobs add column if not exists not_before timestamptz;

-- The memory of the agent: lessons it learned (fixes, routes, facts), for all users or for one user.
create table if not exists agent_memory (
  id         bigserial primary key,
  user_id    text not null,
  scope      text not null,   -- global | user
  topic      text not null,
  lesson     text not null,
  created_at timestamptz not null default now()
);
create index if not exists agent_memory_scope on agent_memory(scope, created_at desc);
create index if not exists agent_memory_user on agent_memory(user_id, created_at desc);

-- Chats of each user. One row per conversation, one row per message. A message holds its parts as JSON.
create table if not exists chats (
  id         uuid primary key default gen_random_uuid(),
  user_id    text not null references users(id),
  session_id text,
  title      text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists chats_user on chats(user_id, updated_at desc);
create index if not exists chats_session on chats(user_id, session_id);
create table if not exists chat_messages (
  id         bigserial primary key,
  chat_id    uuid not null references chats(id) on delete cascade,
  role       text not null,
  parts      jsonb not null default '[]',
  cost       jsonb,
  error      text,
  created_at timestamptz not null default now()
);
create index if not exists chat_messages_chat on chat_messages(chat_id, id);

-- Resting Perpl orders that the server placed. The Exchange contract has no list of the orders of one account.
create table if not exists perpl_orders (
  user_id    text not null references users(id),
  address    text not null,
  market_id  integer not null,
  order_id   integer not null,
  created_at timestamptz not null default now(),
  primary key (address, market_id, order_id)
);
