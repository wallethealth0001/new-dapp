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

revoke all on function public.reconcile_lifetime_transfer_volume() from public, anon, authenticated;
grant execute on function public.reconcile_lifetime_transfer_volume() to service_role;

notify pgrst, 'reload schema';
