-- Phase 5 HR policies. Apply after 004_phase4_grievances.sql.
-- Published versions are immutable; acknowledgements reference version_id.

create table if not exists public.hr_policies (
  id uuid primary key default gen_random_uuid(),
  title text not null unique,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.hr_policy_versions (
  id uuid primary key default gen_random_uuid(),
  policy_id uuid not null references public.hr_policies (id) on delete cascade,
  version_label text not null,
  effective_date date,
  content text not null,
  status text not null check (status in ('draft', 'published')),
  acknowledgement_required boolean not null default true,
  published_at timestamptz,
  created_at timestamptz not null default now(),
  unique (policy_id, version_label)
);

create table if not exists public.policy_acknowledgements (
  id uuid primary key default gen_random_uuid(),
  employee_id uuid not null references public.employees (id) on delete cascade,
  version_id uuid not null references public.hr_policy_versions (id) on delete restrict,
  accepted_at timestamptz not null default now(),
  unique (employee_id, version_id)
);

create index if not exists hr_policy_versions_policy_id_idx on public.hr_policy_versions (policy_id);
create index if not exists hr_policy_versions_status_idx on public.hr_policy_versions (status);
create index if not exists policy_acknowledgements_version_id_idx on public.policy_acknowledgements (version_id);

drop trigger if exists hr_policies_set_updated_at on public.hr_policies;
create trigger hr_policies_set_updated_at
  before update on public.hr_policies
  for each row execute procedure public.set_updated_at();

alter table public.hr_policies enable row level security;
alter table public.hr_policy_versions enable row level security;
alter table public.policy_acknowledgements enable row level security;

drop policy if exists hr_policies_select on public.hr_policies;
create policy hr_policies_select on public.hr_policies for select to authenticated
  using (public.authorize('policies.view') or public.authorize('policies.manage') or public.authorize('reports.view'));

drop policy if exists hr_policies_write on public.hr_policies;
create policy hr_policies_write on public.hr_policies for all to authenticated
  using (public.authorize('policies.manage')) with check (public.authorize('policies.manage'));

drop policy if exists hr_policy_versions_select on public.hr_policy_versions;
create policy hr_policy_versions_select on public.hr_policy_versions for select to authenticated
  using (
    status = 'published'
    or public.authorize('policies.manage')
    or public.authorize('reports.view')
  );

drop policy if exists hr_policy_versions_write on public.hr_policy_versions;
create policy hr_policy_versions_write on public.hr_policy_versions for all to authenticated
  using (public.authorize('policies.manage')) with check (public.authorize('policies.manage'));

drop policy if exists policy_acknowledgements_select on public.policy_acknowledgements;
create policy policy_acknowledgements_select on public.policy_acknowledgements for select to authenticated
  using (
    exists (select 1 from public.employees e where e.id = employee_id and e.user_id = auth.uid())
    or public.authorize('policies.manage')
    or public.authorize('reports.view')
  );

drop policy if exists policy_acknowledgements_insert on public.policy_acknowledgements;
create policy policy_acknowledgements_insert on public.policy_acknowledgements for insert to authenticated
  with check (
    exists (select 1 from public.employees e where e.id = employee_id and e.user_id = auth.uid())
    and public.authorize('policies.view')
  );

grant all on public.hr_policies, public.hr_policy_versions, public.policy_acknowledgements to service_role;

insert into public.hr_policies (id, title) values
  ('00000000-0000-4000-8000-000000000501', 'Code of Conduct'),
  ('00000000-0000-4000-8000-000000000502', 'Attendance Policy'),
  ('00000000-0000-4000-8000-000000000503', 'Leave Policy')
on conflict (title) do nothing;

insert into public.hr_policy_versions (
  id, policy_id, version_label, effective_date, content, status, acknowledgement_required, published_at
) values
  (
    '00000000-0000-4000-8000-000000000511',
    '00000000-0000-4000-8000-000000000501',
    '1.0',
    '2026-01-01',
    'Employees must act with integrity, respect colleagues, and follow company standards.',
    'published',
    true,
    now()
  ),
  (
    '00000000-0000-4000-8000-000000000512',
    '00000000-0000-4000-8000-000000000502',
    '1.0',
    '2026-01-01',
    'Employees must punch in and out honestly and request corrections when a punch is missed.',
    'published',
    true,
    now()
  ),
  (
    '00000000-0000-4000-8000-000000000513',
    '00000000-0000-4000-8000-000000000503',
    '1.0',
    '2026-01-01',
    'Leave applications follow published leave policies. Balances are tracked in the leave ledger.',
    'published',
    true,
    now()
  )
on conflict (policy_id, version_label) do nothing;

notify pgrst, 'reload schema';
