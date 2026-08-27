-- Directory lifecycle: temporary deactivate stays on status; permanent remove uses deleted_at.

alter table public.employees
  add column if not exists deleted_at timestamptz;

create index if not exists employees_deleted_at_idx on public.employees (deleted_at);

notify pgrst, 'reload schema';
