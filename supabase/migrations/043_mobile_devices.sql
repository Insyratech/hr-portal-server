-- Mobile device tokens for push notifications (Phase 2).

create table if not exists public.mobile_devices (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  device_id text not null,
  platform text not null check (platform in ('android', 'ios')),
  push_token text not null,
  app_version text,
  last_seen_at timestamptz not null default now(),
  revoked_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint mobile_devices_user_device_unique unique (user_id, device_id)
);

create unique index if not exists mobile_devices_push_token_active_idx
  on public.mobile_devices (push_token)
  where revoked_at is null;

create index if not exists mobile_devices_user_active_idx
  on public.mobile_devices (user_id)
  where revoked_at is null;

drop trigger if exists mobile_devices_set_updated_at on public.mobile_devices;
create trigger mobile_devices_set_updated_at
  before update on public.mobile_devices
  for each row execute procedure public.set_updated_at();

alter table public.mobile_devices enable row level security;

drop policy if exists mobile_devices_select_own on public.mobile_devices;
create policy mobile_devices_select_own on public.mobile_devices
  for select to authenticated
  using (user_id = auth.uid());

drop policy if exists mobile_devices_insert_own on public.mobile_devices;
create policy mobile_devices_insert_own on public.mobile_devices
  for insert to authenticated
  with check (user_id = auth.uid());

drop policy if exists mobile_devices_update_own on public.mobile_devices;
create policy mobile_devices_update_own on public.mobile_devices
  for update to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

grant select, insert, update, delete on public.mobile_devices to authenticated;
grant all on public.mobile_devices to service_role;

notify pgrst, 'reload schema';
