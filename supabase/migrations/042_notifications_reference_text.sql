-- Notifications reference_id must accept period keys (2026-07), week starts, and other non-UUID ids.

alter table public.notifications
  alter column reference_id type text using reference_id::text;

notify pgrst, 'reload schema';
