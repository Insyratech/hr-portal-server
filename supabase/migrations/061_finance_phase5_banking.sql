-- Finance Phase 5: banking (accounts, manual txns, CSV import, match/categorize, reconciliation).
-- Additive; depends on 056–060. Import-first; no bank feed APIs.

insert into public.permissions (code, description) values
  ('finance.banking.view', 'View bank accounts, transactions, and reconciliation'),
  ('finance.banking.manage', 'Manage bank accounts, import statements, match and categorize')
on conflict (code) do nothing;

insert into public.role_permissions (role_id, permission_id)
select r.id, p.id
from public.roles r
cross join public.permissions p
where r.code = 'FINANCE_MANAGER'
  and p.code in ('finance.banking.view', 'finance.banking.manage')
on conflict do nothing;

insert into public.finance_number_series (document_type, prefix, pad_length, next_number, fiscal_year_label, reset_yearly) values
  ('bank_transaction', 'BT', 4, 1, '2026-27', true)
on conflict (document_type, fiscal_year_label) do nothing;

-- ---------------------------------------------------------------------------
-- Bank / cash accounts (linked to COA)
-- ---------------------------------------------------------------------------
create table if not exists public.finance_bank_accounts (
  id uuid primary key default gen_random_uuid(),
  gl_account_id uuid not null unique references public.finance_accounts (id) on delete restrict,
  display_name text not null,
  account_kind text not null default 'bank' check (account_kind in ('bank', 'cash')),
  bank_name text not null default '',
  account_number_masked text not null default '',
  currency_code text not null default 'INR',
  is_active boolean not null default true,
  notes text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

drop trigger if exists finance_bank_accounts_set_updated_at on public.finance_bank_accounts;
create trigger finance_bank_accounts_set_updated_at
  before update on public.finance_bank_accounts
  for each row execute procedure public.set_updated_at();

-- Seed from system Cash / Bank COA rows
insert into public.finance_bank_accounts (gl_account_id, display_name, account_kind, bank_name)
select a.id, a.name, 'cash', ''
from public.finance_accounts a
where a.system_role = 'cash'
on conflict (gl_account_id) do nothing;

insert into public.finance_bank_accounts (gl_account_id, display_name, account_kind, bank_name)
select a.id, a.name, 'bank', 'Primary bank'
from public.finance_accounts a
where a.system_role = 'bank'
on conflict (gl_account_id) do nothing;

-- ---------------------------------------------------------------------------
-- Import batches
-- ---------------------------------------------------------------------------
create table if not exists public.finance_bank_import_batches (
  id uuid primary key default gen_random_uuid(),
  bank_account_id uuid not null references public.finance_bank_accounts (id) on delete cascade,
  filename text not null default 'statement.csv',
  imported_at timestamptz not null default now(),
  imported_by uuid references public.employees (id) on delete set null,
  row_count integer not null default 0,
  notes text not null default ''
);

-- ---------------------------------------------------------------------------
-- Bank transactions (statement lines + manual)
-- ---------------------------------------------------------------------------
create table if not exists public.finance_bank_transactions (
  id uuid primary key default gen_random_uuid(),
  document_number text not null unique,
  bank_account_id uuid not null references public.finance_bank_accounts (id) on delete restrict,
  transaction_date date not null,
  description text not null default '',
  reference text not null default '',
  -- credit = money into bank (deposit); debit = money out (withdrawal)
  transaction_type text not null check (transaction_type in ('credit', 'debit')),
  amount numeric(14, 2) not null check (amount > 0),
  source text not null default 'manual' check (source in ('manual', 'import')),
  import_batch_id uuid references public.finance_bank_import_batches (id) on delete set null,
  status text not null default 'unmatched'
    check (status in ('unmatched', 'matched', 'categorized', 'excluded')),
  -- Match to existing posted documents (no new journal)
  match_type text
    check (
      match_type is null
      or match_type in (
        'customer_payment',
        'vendor_payment',
        'expense',
        'expense_reimbursement',
        'transfer'
      )
    ),
  match_id uuid,
  -- Categorize: post journal to this offset GL account
  category_account_id uuid references public.finance_accounts (id) on delete set null,
  journal_id uuid references public.finance_journal_entries (id) on delete set null,
  -- Transfer offset bank account (when match_type = transfer)
  transfer_bank_account_id uuid references public.finance_bank_accounts (id) on delete set null,
  notes text not null default '',
  created_by uuid references public.employees (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists finance_bank_transactions_account_date_idx
  on public.finance_bank_transactions (bank_account_id, transaction_date);
create index if not exists finance_bank_transactions_status_idx
  on public.finance_bank_transactions (status);

drop trigger if exists finance_bank_transactions_set_updated_at on public.finance_bank_transactions;
create trigger finance_bank_transactions_set_updated_at
  before update on public.finance_bank_transactions
  for each row execute procedure public.set_updated_at();

-- ---------------------------------------------------------------------------
-- Saved reconciliation snapshots (optional close of a period)
-- ---------------------------------------------------------------------------
create table if not exists public.finance_bank_reconciliations (
  id uuid primary key default gen_random_uuid(),
  bank_account_id uuid not null references public.finance_bank_accounts (id) on delete restrict,
  statement_date date not null,
  statement_ending_balance numeric(14, 2) not null,
  book_ending_balance numeric(14, 2) not null,
  difference numeric(14, 2) not null,
  unmatched_count integer not null default 0,
  unmatched_amount numeric(14, 2) not null default 0,
  matched_count integer not null default 0,
  status text not null default 'draft' check (status in ('draft', 'completed')),
  notes text not null default '',
  completed_at timestamptz,
  created_by uuid references public.employees (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

drop trigger if exists finance_bank_reconciliations_set_updated_at on public.finance_bank_reconciliations;
create trigger finance_bank_reconciliations_set_updated_at
  before update on public.finance_bank_reconciliations
  for each row execute procedure public.set_updated_at();

-- ---------------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------------
alter table public.finance_bank_accounts enable row level security;
alter table public.finance_bank_import_batches enable row level security;
alter table public.finance_bank_transactions enable row level security;
alter table public.finance_bank_reconciliations enable row level security;

do $$
declare
  t text;
begin
  foreach t in array array[
    'finance_bank_accounts',
    'finance_bank_import_batches',
    'finance_bank_transactions',
    'finance_bank_reconciliations'
  ]
  loop
    execute format('drop policy if exists %I_all on public.%I', t, t);
    execute format(
      'create policy %I_all on public.%I for all to authenticated using (
        public.authorize(''finance.banking.view'')
        or public.authorize(''finance.banking.manage'')
      ) with check (
        public.authorize(''finance.banking.manage'')
      )',
      t, t
    );
  end loop;
end $$;

notify pgrst, 'reload schema';
