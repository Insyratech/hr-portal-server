-- Phase 5: HR requests directory edit; SA unlocks one employee at a time.

create table if not exists public.directory_edit_requests (
  id uuid primary key default gen_random_uuid(),
  target_employee_id uuid not null references public.employees (id) on delete cascade,
  requester_id uuid not null references public.employees (id) on delete restrict,
  reason text not null,
  field_hints text,
  status text not null default 'PENDING'
    check (status in ('PENDING', 'APPROVED', 'REJECTED', 'FULFILLED', 'CANCELLED')),
  decided_by uuid references public.employees (id) on delete set null,
  decision_note text,
  unlocked_until timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  decided_at timestamptz,
  fulfilled_at timestamptz
);

create index if not exists directory_edit_requests_target_idx
  on public.directory_edit_requests (target_employee_id, status);

create index if not exists directory_edit_requests_status_idx
  on public.directory_edit_requests (status, created_at desc);

create index if not exists directory_edit_requests_requester_idx
  on public.directory_edit_requests (requester_id, created_at desc);

-- At most one open request (pending or approved unlock) per target.
create unique index if not exists directory_edit_requests_open_target_uidx
  on public.directory_edit_requests (target_employee_id)
  where status in ('PENDING', 'APPROVED');

alter table public.directory_edit_requests enable row level security;

drop policy if exists directory_edit_requests_select on public.directory_edit_requests;
create policy directory_edit_requests_select on public.directory_edit_requests for select to authenticated
  using (
    public.authorize('users.manage')
    or public.authorize('users.view')
  );

notify pgrst, 'reload schema';
