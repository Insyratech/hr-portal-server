-- Permission is 1 hour per day, twice a month, at shift start or shift end.

alter table public.work_permissions
  add column if not exists slot text not null default 'START';

alter table public.work_permissions drop constraint if exists work_permissions_slot_check;
alter table public.work_permissions
  add constraint work_permissions_slot_check check (slot in ('START', 'END'));

notify pgrst, 'reload schema';
