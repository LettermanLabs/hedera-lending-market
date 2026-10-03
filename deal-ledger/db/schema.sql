-- LettermanLabs deal ledger (Supabase / PostgreSQL).
-- The full canonical record stays here; Hedera only gets the small payload
-- bound to record_sha256. Row Level Security: only service_role writes;
-- workspace members read their own workspace's rows via workspace_id.

create table if not exists public.deal_ledger_entries (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  deal_id text not null,
  asset_id text not null,
  buyer_id text not null,
  seller_id text not null,
  status text not null default 'completed' check (status in ('completed', 'resold', 'void')),
  price_disclosed boolean not null default false,
  price_amount numeric(20, 2),
  price_currency text,
  canonical_record jsonb not null,
  record_sha256 text not null,
  network text not null check (network in ('testnet', 'mainnet')),
  topic_id text,
  transaction_id text,
  sequence_number bigint,
  consensus_timestamp text,
  title_token_id text,
  title_serial_number bigint,
  created_at timestamptz not null default now()
);

-- The double-sale guard: at most one active completed entry per asset.
create unique index if not exists one_completed_deal_per_asset
  on public.deal_ledger_entries (asset_id)
  where status = 'completed';

create index if not exists deal_ledger_entries_deal_idx
  on public.deal_ledger_entries (deal_id);

-- Verification lookup by receipt.
create unique index if not exists deal_ledger_entries_receipt_idx
  on public.deal_ledger_entries (topic_id, sequence_number)
  where topic_id is not null;

alter table public.deal_ledger_entries enable row level security;

create policy "workspace members read their ledger"
  on public.deal_ledger_entries for select
  using (workspace_id in (select workspace_id from public.workspace_members where user_id = auth.uid()));

-- Inserts/updates come from the service role (server-side completion flow only).
