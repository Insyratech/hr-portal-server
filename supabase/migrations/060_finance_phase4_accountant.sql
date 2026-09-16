-- Finance Phase 4: accountant core — journals UI, GL, TB, opening balances, period lock.
-- Additive; depends on 056–059. All document posting already uses postBalancedJournal.

insert into public.permissions (code, description) values
  ('finance.accountant.view', 'View journals, ledger, trial balance, period locks'),
  ('finance.accountant.manage', 'Create journals, opening balances, reverse entries, lock periods')
on conflict (code) do nothing;

insert into public.role_permissions (role_id, permission_id)
select r.id, p.id
from public.roles r
cross join public.permissions p
where r.code = 'FINANCE_MANAGER'
  and p.code in ('finance.accountant.view', 'finance.accountant.manage')
on conflict do nothing;

-- Manual journals may be draft before post; reversed after reverse journal
alter table public.finance_journal_entries
  drop constraint if exists finance_journal_entries_status_check;

alter table public.finance_journal_entries
  add constraint finance_journal_entries_status_check
  check (status in ('draft', 'posted', 'reversed'));

alter table public.finance_journal_entries
  add column if not exists reverses_journal_id uuid references public.finance_journal_entries (id) on delete set null;

alter table public.finance_journal_entries
  add column if not exists reversed_by_journal_id uuid references public.finance_journal_entries (id) on delete set null;

create index if not exists finance_journal_entries_date_idx
  on public.finance_journal_entries (entry_date);

create index if not exists finance_journal_lines_account_idx
  on public.finance_journal_lines (account_id);

-- ---------------------------------------------------------------------------
-- Period / transaction lock (close month)
-- ---------------------------------------------------------------------------
create table if not exists public.finance_period_locks (
  id uuid primary key default gen_random_uuid(),
  period_year integer not null check (period_year >= 2000 and period_year <= 2100),
  period_month integer not null check (period_month >= 1 and period_month <= 12),
  locked_at timestamptz not null default now(),
  locked_by uuid references public.employees (id) on delete set null,
  notes text not null default '',
  unique (period_year, period_month)
);

-- ---------------------------------------------------------------------------
-- Opening balances (posted as one journal when finalized)
-- ---------------------------------------------------------------------------
create table if not exists public.finance_opening_balance_sets (
  id uuid primary key default gen_random_uuid(),
  as_of_date date not null,
  memo text not null default 'Opening balances',
  status text not null default 'draft' check (status in ('draft', 'posted', 'void')),
  journal_id uuid references public.finance_journal_entries (id) on delete set null,
  created_by uuid references public.employees (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (as_of_date)
);

drop trigger if exists finance_opening_balance_sets_set_updated_at on public.finance_opening_balance_sets;
create trigger finance_opening_balance_sets_set_updated_at
  before update on public.finance_opening_balance_sets
  for each row execute procedure public.set_updated_at();

create table if not exists public.finance_opening_balance_lines (
  id uuid primary key default gen_random_uuid(),
  set_id uuid not null references public.finance_opening_balance_sets (id) on delete cascade,
  account_id uuid not null references public.finance_accounts (id) on delete restrict,
  debit numeric(14, 2) not null default 0 check (debit >= 0),
  credit numeric(14, 2) not null default 0 check (credit >= 0),
  unique (set_id, account_id),
  check (not (debit > 0 and credit > 0)),
  check (debit > 0 or credit > 0)
);

-- ---------------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------------
alter table public.finance_period_locks enable row level security;
alter table public.finance_opening_balance_sets enable row level security;
alter table public.finance_opening_balance_lines enable row level security;

do $$
declare
  t text;
begin
  foreach t in array array[
    'finance_period_locks',
    'finance_opening_balance_sets',
    'finance_opening_balance_lines'
  ]
  loop
    execute format('drop policy if exists %I_all on public.%I', t, t);
    execute format(
      'create policy %I_all on public.%I for all to authenticated using (
        public.authorize(''finance.accountant.view'')
        or public.authorize(''finance.accountant.manage'')
        or public.authorize(''finance.coa.view'')
        or public.authorize(''finance.coa.manage'')
      ) with check (
        public.authorize(''finance.accountant.manage'')
      )',
      t, t
    );
  end loop;
end $$;

-- Expand journal RLS to accountant (API uses service role; policies for completeness)
drop policy if exists finance_journal_entries_all on public.finance_journal_entries;
create policy finance_journal_entries_all on public.finance_journal_entries
  for all to authenticated
  using (
    public.authorize('finance.accountant.view')
    or public.authorize('finance.accountant.manage')
    or public.authorize('finance.purchase.view')
    or public.authorize('finance.purchase.manage')
    or public.authorize('finance.sales.view')
    or public.authorize('finance.sales.manage')
    or public.authorize('finance.expense.view')
    or public.authorize('finance.expense.manage')
    or public.authorize('finance.coa.view')
  )
  with check (
    public.authorize('finance.accountant.manage')
    or public.authorize('finance.purchase.manage')
    or public.authorize('finance.sales.manage')
    or public.authorize('finance.expense.manage')
  );

drop policy if exists finance_journal_lines_all on public.finance_journal_lines;
create policy finance_journal_lines_all on public.finance_journal_lines
  for all to authenticated
  using (
    public.authorize('finance.accountant.view')
    or public.authorize('finance.accountant.manage')
    or public.authorize('finance.purchase.view')
    or public.authorize('finance.purchase.manage')
    or public.authorize('finance.sales.view')
    or public.authorize('finance.sales.manage')
    or public.authorize('finance.expense.view')
    or public.authorize('finance.expense.manage')
    or public.authorize('finance.coa.view')
  )
  with check (
    public.authorize('finance.accountant.manage')
    or public.authorize('finance.purchase.manage')
    or public.authorize('finance.sales.manage')
    or public.authorize('finance.expense.manage')
  );

notify pgrst, 'reload schema';
