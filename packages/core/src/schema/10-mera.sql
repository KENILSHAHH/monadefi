-- Mera accounts: the user id is the passkey wallet address. The server holds no key of it.
alter table users add column if not exists auth_kind text;  -- 'mera' for a passkey account

-- Session delegations from the Mera wallet to the agent key of the user, on Monad. Signatures are untrusted storage:
-- the DelegationManager checks them on-chain, and the phone can sign them again.
create table if not exists mera_sessions (
  id          text primary key,
  user_id     text not null references users(id),
  owner       text not null,
  kind        text not null,                     -- perpl_trade | ausd_approve
  delegation  jsonb not null,
  signature   text,
  status      text not null default 'pending',   -- pending | active | replaced | revoked
  expires_at  timestamptz not null,
  created_at  timestamptz not null default now()
);
create index if not exists mera_sessions_user on mera_sessions(user_id, status);

-- One-time relays: the phone signs a delegation for an exact batch of calls, and the gas sponsor sends it.
create table if not exists relays (
  id          text primary key,
  user_id     text not null references users(id),
  calls       jsonb not null,
  delegation  jsonb not null,
  status      text not null default 'pending',   -- pending | sending | done | failed
  hash        text,
  error       text,
  expires_at  timestamptz not null,
  created_at  timestamptz not null default now()
);
create index if not exists relays_user on relays(user_id, created_at desc);
