-- Finance Phase 3: direct expenses, employee claims, reimbursements.
-- Additive; depends on 056–058.

insert into public.permissions (code, description) values
  ('finance.expense.view', 'View direct expenses and reimbursements'),
  ('finance.expense.manage', 'Create and post direct expenses and reimbursements'),
  ('finance.expense_claim.apply', 'Create and submit expense claims'),
  ('finance.expense_claim.approve', 'Approve or reject expense claims')
on conflict (code) do nothing;

insert into public.role_permissions (role_id, permission_id)
select r.id, p.id
from public.roles r
cross join public.permissions p
where r.code = 'FINANCE_MANAGER'
  and p.code in (
    'finance.expense.view',
    'finance.expense.manage',
    'finance.expense_claim.apply',
    'finance.expense_claim.approve'
  )
on conflict do nothing;

insert into public.role_permissions (role_id, permission_id)
select r.id, p.id
from public.roles r
cross join public.permissions p
where r.code = 'EMPLOYEE'
  and p.code = 'finance.expense_claim.apply'
on conflict do nothing;

-- Employee payable liability for reimbursements
insert into public.finance_accounts (code, name, account_type, system_role, is_system, sort_order) values
  ('2010', 'Employee Payable', 'liability', 'employee_payable', true, 15)
on conflict (code) do nothing;

update public.finance_accounts
set system_role = 'employee_payable'
where code = '2010' and (system_role is null or system_role <> 'employee_payable');

-- Mark office expenses as default expense account when needed
update public.finance_accounts
set system_role = coalesce(system_role, 'office_expense')
where code = '5200' and system_role is null;

insert into public.finance_number_series (document_type, prefix, pad_length, next_number, fiscal_year_label, reset_yearly) values
  ('expense_claim', 'EC', 4, 1, '2026-27', true),
  ('reimbursement', 'REIM', 4, 1, '2026-27', true)
on conflict (document_type, fiscal_year_label) do nothing;

-- ---------------------------------------------------------------------------
-- Categories
-- ---------------------------------------------------------------------------
create table if not exists public.finance_expense_categories (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  expense_account_id uuid not null references public.finance_accounts (id) on delete restrict,
  description text not null default '',
  is_active boolean not null default true,
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

drop trigger if exists finance_expense_categories_set_updated_at on public.finance_expense_categories;
create trigger finance_expense_categories_set_updated_at
  before update on public.finance_expense_categories
  for each row execute procedure public.set_updated_at();

insert into public.finance_expense_categories (name, expense_account_id, description, sort_order)
select 'Office supplies', a.id, 'Stationery and office consumables', 10
from public.finance_accounts a where a.code = '5200'
on conflict (name) do nothing;

insert into public.finance_expense_categories (name, expense_account_id, description, sort_order)
select 'Travel', a.id, 'Travel and conveyance', 20
from public.finance_accounts a where a.code = '5200'
on conflict (name) do nothing;

insert into public.finance_expense_categories (name, expense_account_id, description, sort_order)
select 'Meals & entertainment', a.id, 'Client and staff meals', 30
from public.finance_accounts a where a.code = '5200'
on conflict (name) do nothing;

insert into public.finance_expense_categories (name, expense_account_id, description, sort_order)
select 'Utilities', a.id, 'Rent, internet, utilities', 40
from public.finance_accounts a where a.code = '5400'
on conflict (name) do nothing;

-- ---------------------------------------------------------------------------
-- Direct expenses
-- ---------------------------------------------------------------------------
create table if not exists public.finance_expenses (
  id uuid primary key default gen_random_uuid(),
  document_number text not null unique,
  expense_date date not null default (timezone('Asia/Kolkata', now()))::date,
  category_id uuid references public.finance_expense_categories (id) on delete set null,
  vendor_id uuid references public.finance_vendors (id) on delete set null,
  expense_account_id uuid not null references public.finance_accounts (id) on delete restrict,
  description text not null default '',
  amount numeric(14, 2) not null check (amount >= 0),
  tax_percent numeric(8, 4) not null default 0,
  tax_amount numeric(14, 2) not null default 0,
  grand_total numeric(14, 2) not null default 0,
  -- paid: Cr bank/cash immediately; unpaid: Cr AP (vendor required)
  paid_through text not null default 'bank'
    check (paid_through in ('cash', 'bank', 'accounts_payable')),
  bank_account_id uuid references public.finance_accounts (id) on delete set null,
  vendor_invoice_number text not null default '',
  receipt_url text not null default '',
  notes text not null default '',
  status text not null default 'draft' check (status in ('draft', 'posted', 'void')),
  journal_id uuid references public.finance_journal_entries (id) on delete set null,
  created_by uuid references public.employees (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists finance_expenses_status_idx on public.finance_expenses (status);
create index if not exists finance_expenses_date_idx on public.finance_expenses (expense_date);

drop trigger if exists finance_expenses_set_updated_at on public.finance_expenses;
create trigger finance_expenses_set_updated_at
  before update on public.finance_expenses
  for each row execute procedure public.set_updated_at();

-- ---------------------------------------------------------------------------
-- Expense claims (employee)
-- ---------------------------------------------------------------------------
create table if not exists public.finance_expense_claims (
  id uuid primary key default gen_random_uuid(),
  document_number text not null unique,
  employee_id uuid not null references public.employees (id) on delete restrict,
  department_id uuid references public.departments (id) on delete set null,
  category_id uuid references public.finance_expense_categories (id) on delete set null,
  expense_account_id uuid references public.finance_accounts (id) on delete set null,
  claim_date date not null default (timezone('Asia/Kolkata', now()))::date,
  description text not null,
  amount numeric(14, 2) not null check (amount >= 0),
  tax_percent numeric(8, 4) not null default 0,
  tax_amount numeric(14, 2) not null default 0,
  grand_total numeric(14, 2) not null default 0,
  vendor_name text not null default '',
  bill_number text not null default '',
  receipt_url text not null default '',
  notes text not null default '',
  status text not null default 'draft'
    check (status in ('draft', 'submitted', 'approved', 'rejected', 'reimbursed', 'cancelled')),
  reviewer_id uuid references public.employees (id) on delete set null,
  reviewer_comment text,
  decided_at timestamptz,
  amount_reimbursed numeric(14, 2) not null default 0,
  journal_id uuid references public.finance_journal_entries (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists finance_expense_claims_employee_idx on public.finance_expense_claims (employee_id);
create index if not exists finance_expense_claims_status_idx on public.finance_expense_claims (status);

drop trigger if exists finance_expense_claims_set_updated_at on public.finance_expense_claims;
create trigger finance_expense_claims_set_updated_at
  before update on public.finance_expense_claims
  for each row execute procedure public.set_updated_at();

-- ---------------------------------------------------------------------------
-- Reimbursements
-- ---------------------------------------------------------------------------
create table if not exists public.finance_expense_reimbursements (
  id uuid primary key default gen_random_uuid(),
  document_number text not null unique,
  employee_id uuid not null references public.employees (id) on delete restrict,
  payment_date date not null default (timezone('Asia/Kolkata', now()))::date,
  amount numeric(14, 2) not null check (amount > 0),
  bank_account_id uuid references public.finance_accounts (id) on delete set null,
  method text not null default 'bank_transfer',
  reference text not null default '',
  notes text not null default '',
  status text not null default 'draft' check (status in ('draft', 'posted', 'void')),
  journal_id uuid references public.finance_journal_entries (id) on delete set null,
  created_by uuid references public.employees (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

drop trigger if exists finance_expense_reimbursements_set_updated_at on public.finance_expense_reimbursements;
create trigger finance_expense_reimbursements_set_updated_at
  before update on public.finance_expense_reimbursements
  for each row execute procedure public.set_updated_at();

create table if not exists public.finance_expense_reimbursement_allocations (
  id uuid primary key default gen_random_uuid(),
  reimbursement_id uuid not null references public.finance_expense_reimbursements (id) on delete cascade,
  claim_id uuid not null references public.finance_expense_claims (id) on delete restrict,
  amount numeric(14, 2) not null check (amount > 0),
  unique (reimbursement_id, claim_id)
);

-- ---------------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------------
alter table public.finance_expense_categories enable row level security;
alter table public.finance_expenses enable row level security;
alter table public.finance_expense_claims enable row level security;
alter table public.finance_expense_reimbursements enable row level security;
alter table public.finance_expense_reimbursement_allocations enable row level security;

do $$
declare
  t text;
begin
  foreach t in array array[
    'finance_expense_categories',
    'finance_expenses',
    'finance_expense_reimbursements',
    'finance_expense_reimbursement_allocations'
  ]
  loop
    execute format('drop policy if exists %I_all on public.%I', t, t);
    execute format(
      'create policy %I_all on public.%I for all to authenticated using (
        public.authorize(''finance.expense.view'')
        or public.authorize(''finance.expense.manage'')
        or public.authorize(''finance.expense_claim.approve'')
      ) with check (
        public.authorize(''finance.expense.manage'')
      )',
      t, t
    );
  end loop;
end $$;

drop policy if exists finance_expense_claims_all on public.finance_expense_claims;
create policy finance_expense_claims_all on public.finance_expense_claims
  for all to authenticated
  using (
    public.authorize('finance.expense.view')
    or public.authorize('finance.expense.manage')
    or public.authorize('finance.expense_claim.approve')
    or public.authorize('finance.expense_claim.apply')
  )
  with check (
    public.authorize('finance.expense.manage')
    or public.authorize('finance.expense_claim.approve')
    or public.authorize('finance.expense_claim.apply')
  );

-- Categories readable by claim appliers too
drop policy if exists finance_expense_categories_all on public.finance_expense_categories;
create policy finance_expense_categories_all on public.finance_expense_categories
  for all to authenticated
  using (
    public.authorize('finance.expense.view')
    or public.authorize('finance.expense.manage')
    or public.authorize('finance.expense_claim.apply')
    or public.authorize('finance.expense_claim.approve')
  )
  with check (
    public.authorize('finance.expense.manage')
  );

notify pgrst, 'reload schema';
