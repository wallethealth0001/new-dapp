create table if not exists public."incomingTransferEvents" (
  id text primary key,
  record jsonb not null,
  created_at timestamptz not null
);

create table if not exists public."incomingTelegramDeliveries" (
  id text primary key,
  record jsonb not null,
  created_at timestamptz not null
);

create index if not exists incoming_transfer_events_created_at_idx
  on public."incomingTransferEvents" (created_at);
create index if not exists incoming_transfer_events_wallet_idx
  on public."incomingTransferEvents" ((record->>'walletAddress'));
create index if not exists incoming_telegram_deliveries_created_at_idx
  on public."incomingTelegramDeliveries" (created_at);

alter table public."incomingTransferEvents" enable row level security;
alter table public."incomingTelegramDeliveries" enable row level security;
revoke all on public."incomingTransferEvents", public."incomingTelegramDeliveries" from anon, authenticated;
grant all on public."incomingTransferEvents", public."incomingTelegramDeliveries" to service_role;

notify pgrst, 'reload schema';
