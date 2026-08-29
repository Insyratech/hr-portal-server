-- Phase 3: biometric device session fields on mobile_devices.

alter table public.mobile_devices
  alter column push_token drop not null;

alter table public.mobile_devices
  add column if not exists credential_hash text,
  add column if not exists last_credential_auth_at timestamptz,
  add column if not exists last_biometric_refresh_at timestamptz,
  add column if not exists enrolled_at timestamptz,
  add column if not exists biometric_enabled boolean not null default false;

create index if not exists mobile_devices_biometric_active_idx
  on public.mobile_devices (user_id, device_id)
  where revoked_at is null and biometric_enabled = true;

notify pgrst, 'reload schema';
