create table if not exists public.wallets (
  id text primary key,
  record jsonb not null,
  created_at timestamptz not null
);

create table if not exists public.history (
  id text primary key,
  record jsonb not null,
  created_at timestamptz not null
);

create table if not exists public."approvalEvents" (
  id text primary key,
  record jsonb not null,
  created_at timestamptz not null
);

create table if not exists public."transferEvents" (
  id text primary key,
  record jsonb not null,
  created_at timestamptz not null
);

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

create table if not exists public."monitoringState" (
  id text primary key,
  record jsonb not null,
  created_at timestamptz not null
);

create table if not exists public."transferVolumeIncrements" (
  transfer_id text primary key,
  raw_amount text not null check (raw_amount ~ '^[0-9]+$')
);

create table if not exists public."transferVolume" (
  id text primary key check (id = 'lifetime'),
  raw_amount text not null check (raw_amount ~ '^[0-9]+$')
);

insert into public."transferVolumeIncrements" (transfer_id, raw_amount)
select id, record->>'amount'
from public.history
where record->>'status' = 'confirmed'
  and record->>'receiver' in ('1', '2')
  and record->>'amount' ~ '^[0-9]+$'
on conflict (transfer_id) do nothing;

insert into public."transferVolume" (id, raw_amount)
select 'lifetime', coalesce(sum(raw_amount::numeric), 0)::text
from public."transferVolumeIncrements"
on conflict (id) do nothing;

create or replace function public.increment_lifetime_transfer_volume(
  p_transfer_id text,
  p_raw_amount text
)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_total text;
begin
  if p_transfer_id is null or p_transfer_id = ''
    or p_raw_amount is null or p_raw_amount !~ '^[0-9]+$'
    or p_raw_amount::numeric <= 0 then
    raise exception 'Invalid transfer volume increment';
  end if;

  insert into public."transferVolumeIncrements" (transfer_id, raw_amount)
  values (p_transfer_id, p_raw_amount)
  on conflict (transfer_id) do nothing;

  if found then
    update public."transferVolume"
    set raw_amount = (raw_amount::numeric + p_raw_amount::numeric)::text
    where id = 'lifetime'
    returning raw_amount into v_total;
  else
    select raw_amount into v_total
    from public."transferVolume"
    where id = 'lifetime';
  end if;

  if v_total is null then
    raise exception 'Lifetime transfer volume counter is not initialized';
  end if;
  return v_total;
end;
$$;

create or replace function public.reconcile_lifetime_transfer_volume()
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_total text;
begin
  with new_increments as (
    insert into public."transferVolumeIncrements" (transfer_id, raw_amount)
    select id, record->>'amount'
    from public.history
    where record->>'status' = 'confirmed'
      and record->>'receiver' in ('1', '2')
      and record->>'amount' ~ '^[0-9]+$'
    on conflict (transfer_id) do nothing
    returning raw_amount
  ),
  missing_total as (
    select coalesce(sum(raw_amount::numeric), 0) as raw_amount
    from new_increments
  )
  update public."transferVolume"
  set raw_amount = (public."transferVolume".raw_amount::numeric + missing_total.raw_amount)::text
  from missing_total
  where id = 'lifetime'
  returning public."transferVolume".raw_amount into v_total;

  if v_total is null then
    raise exception 'Lifetime transfer volume counter is not initialized';
  end if;
  return v_total;
end;
$$;

create index if not exists wallets_created_at_idx on public.wallets (created_at);
create index if not exists history_created_at_idx on public.history (created_at);
create index if not exists approval_events_created_at_idx on public."approvalEvents" (created_at);
create index if not exists transfer_events_created_at_idx on public."transferEvents" (created_at);
create index if not exists incoming_transfer_events_created_at_idx on public."incomingTransferEvents" (created_at);
create index if not exists incoming_transfer_events_wallet_idx on public."incomingTransferEvents" ((record->>'walletAddress'));
create index if not exists incoming_telegram_deliveries_created_at_idx on public."incomingTelegramDeliveries" (created_at);
create index if not exists monitoring_state_created_at_idx on public."monitoringState" (created_at);

alter table public.wallets enable row level security;
alter table public.history enable row level security;
alter table public."approvalEvents" enable row level security;
alter table public."transferEvents" enable row level security;
alter table public."incomingTransferEvents" enable row level security;
alter table public."incomingTelegramDeliveries" enable row level security;
alter table public."monitoringState" enable row level security;
alter table public."transferVolumeIncrements" enable row level security;
alter table public."transferVolume" enable row level security;

revoke all on public.wallets, public.history, public."approvalEvents",
  public."transferEvents", public."incomingTransferEvents", public."incomingTelegramDeliveries",
  public."monitoringState", public."transferVolumeIncrements",
  public."transferVolume" from anon, authenticated;
grant all on public.wallets, public.history, public."approvalEvents",
  public."transferEvents", public."incomingTransferEvents", public."incomingTelegramDeliveries",
  public."monitoringState", public."transferVolumeIncrements",
  public."transferVolume" to service_role;

revoke all on function public.increment_lifetime_transfer_volume(text, text) from public, anon, authenticated;
revoke all on function public.reconcile_lifetime_transfer_volume() from public, anon, authenticated;
grant execute on function public.increment_lifetime_transfer_volume(text, text) to service_role;
grant execute on function public.reconcile_lifetime_transfer_volume() to service_role;
