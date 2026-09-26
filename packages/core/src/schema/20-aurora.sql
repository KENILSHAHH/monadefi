-- Aurora Intents deposits: any asset on any supported chain to the Monad wallet of the user.
-- Every statement is safe to run again.
create table if not exists aurora_deposits (
  id              text primary key,
  user_id         text not null references users(id),
  origin_asset    text not null,                  -- Aurora / 1Click asset id, for example nep141:base-0x8335...omft.near
  origin_chain    text not null,                  -- 1Click chain code: eth, base, arb, sol, btc, ...
  deposit_address text,                           -- the address the user sends to (null until known)
  deposit_memo    text,                           -- required by memo chains (Stellar)
  recipient       text not null,                  -- the Monad address that gets the output (the user)
  refund_to       text not null,                  -- the origin-chain address for refunds
  amount_in       text,                           -- origin units, as a decimal string
  amount_out      text,                           -- destination units (USDC or AUSD, 6 decimals)
  status          text not null,                  -- see auroraDeposits.ts DepositStatus
  aurora_status   text,                           -- the last raw status from Aurora or Intents Connect
  quote           jsonb,
  after_action    jsonb,                          -- for example {"type":"perpl_open","market":"BTC","side":"long","leverage":5}
  settled_tx      text,
  refund_tx       text,
  error           text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

alter table aurora_deposits add column if not exists mode text not null default 'swap';  -- swap | connect | persistent | persistent_child
alter table aurora_deposits add column if not exists destination_asset text;
alter table aurora_deposits add column if not exists execution_id text;              -- Intents Connect execution id
alter table aurora_deposits add column if not exists intermediary text;              -- Intents Connect intermediary on Monad
alter table aurora_deposits add column if not exists sign_payload jsonb;             -- what the user signs (Intents Connect)
alter table aurora_deposits add column if not exists deposit_tx text;                -- origin-chain transaction of the user
alter table aurora_deposits add column if not exists deadline timestamptz;
alter table aurora_deposits add column if not exists refund_amount text;
alter table aurora_deposits add column if not exists refund_reason text;
alter table aurora_deposits add column if not exists next_step jsonb;                -- the result of onSettled
alter table aurora_deposits add column if not exists parent_id text;                 -- persistent_child rows point at their address row
alter table aurora_deposits add column if not exists source_tx text;                 -- persistent_child: the tx hash Aurora reports
alter table aurora_deposits add column if not exists raw jsonb;                      -- the last status response
alter table aurora_deposits add column if not exists next_poll_at timestamptz not null default now();
alter table aurora_deposits add column if not exists claimed_by text;
alter table aurora_deposits add column if not exists claimed_until timestamptz;
alter table aurora_deposits add column if not exists poll_count integer not null default 0;
alter table aurora_deposits add column if not exists settled_at timestamptz;

create index if not exists aurora_deposits_user on aurora_deposits(user_id, created_at desc);
create index if not exists aurora_deposits_poll on aurora_deposits(next_poll_at)
  where status in ('awaiting_signature', 'awaiting_deposit', 'processing', 'incomplete', 'listening');
create index if not exists aurora_deposits_address on aurora_deposits(deposit_address);
create unique index if not exists aurora_deposits_child on aurora_deposits(parent_id, source_tx) where parent_id is not null;
create unique index if not exists aurora_deposits_execution on aurora_deposits(execution_id) where execution_id is not null;
