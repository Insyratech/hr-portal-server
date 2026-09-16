-- Finance Phase 1: procurement documents + journal posting tables.
-- Additive only. Depends on 056_finance_phase0_foundation.sql.

insert into public.permissions (code, description) values
  ('finance.indent.apply', 'Create and submit purchase indents'),
  ('finance.indent.approve', 'Approve or reject purchase indents'),
  ('finance.purchase.view', 'View procurement documents'),
  ('finance.purchase.manage', 'Create and manage POs, receipts, bills, payments, RFQs')
on conflict (code) do nothing;

insert into public.role_permissions (role_id, permission_id)
select r.id, p.id
from public.roles r
cross join public.permissions p
where r.code = 'FINANCE_MANAGER'
  and p.code in (
    'finance.indent.apply',
    'finance.indent.approve',
    'finance.purchase.view',
    'finance.purchase.manage'
  )
on conflict do nothing;

-- Employees can raise indents
insert into public.role_permissions (role_id, permission_id)
select r.id, p.id
from public.roles r
cross join public.permissions p
where r.code = 'EMPLOYEE'
  and p.code = 'finance.indent.apply'
on conflict do nothing;

-- Ensure number series for RFQ / receipt / vendor credit exist
insert into public.finance_number_series (document_type, prefix, pad_length, next_number, fiscal_year_label, reset_yearly) values
  ('rfq', 'RFQ', 4, 1, '2026-27', true),
  ('vendor_quote', 'VQ', 4, 1, '2026-27', true),
  ('receipt', 'GRN', 4, 1, '2026-27', true),
  ('vendor_credit', 'VC', 4, 1, '2026-27', true)
on conflict (document_type, fiscal_year_label) do nothing;

-- ---------------------------------------------------------------------------
-- Journals (Phase 1 posting for bills/payments; Phase 4 expands accountant UI)
-- ---------------------------------------------------------------------------
create table if not exists public.finance_journal_entries (
  id uuid primary key default gen_random_uuid(),
  entry_number text not null unique,
  entry_date date not null default (timezone('Asia/Kolkata', now()))::date,
  memo text not null default '',
  source_type text not null,
  source_id uuid,
  status text not null default 'posted' check (status in ('posted', 'reversed')),
  created_by uuid references public.employees (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists finance_journal_entries_source_idx
  on public.finance_journal_entries (source_type, source_id);

drop trigger if exists finance_journal_entries_set_updated_at on public.finance_journal_entries;
create trigger finance_journal_entries_set_updated_at
  before update on public.finance_journal_entries
  for each row execute procedure public.set_updated_at();

create table if not exists public.finance_journal_lines (
  id uuid primary key default gen_random_uuid(),
  journal_id uuid not null references public.finance_journal_entries (id) on delete cascade,
  account_id uuid not null references public.finance_accounts (id) on delete restrict,
  description text not null default '',
  debit numeric(14, 2) not null default 0 check (debit >= 0),
  credit numeric(14, 2) not null default 0 check (credit >= 0),
  line_order integer not null default 0,
  check (not (debit > 0 and credit > 0)),
  check (debit > 0 or credit > 0)
);

create index if not exists finance_journal_lines_journal_idx on public.finance_journal_lines (journal_id);

-- ---------------------------------------------------------------------------
-- Purchase indents
-- ---------------------------------------------------------------------------
create table if not exists public.finance_purchase_indents (
  id uuid primary key default gen_random_uuid(),
  document_number text not null unique,
  requested_by uuid not null references public.employees (id) on delete restrict,
  department_id uuid references public.departments (id) on delete set null,
  required_date date,
  priority text not null default 'normal' check (priority in ('low', 'normal', 'high', 'urgent')),
  purpose text not null default '',
  justification text not null default '',
  status text not null default 'draft'
    check (status in ('draft', 'submitted', 'approved', 'rejected', 'cancelled', 'converted')),
  estimated_total numeric(14, 2) not null default 0,
  reviewer_id uuid references public.employees (id) on delete set null,
  reviewer_comment text,
  decided_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists finance_purchase_indents_requester_idx
  on public.finance_purchase_indents (requested_by, created_at desc);
create index if not exists finance_purchase_indents_status_idx
  on public.finance_purchase_indents (status);

drop trigger if exists finance_purchase_indents_set_updated_at on public.finance_purchase_indents;
create trigger finance_purchase_indents_set_updated_at
  before update on public.finance_purchase_indents
  for each row execute procedure public.set_updated_at();

create table if not exists public.finance_purchase_indent_lines (
  id uuid primary key default gen_random_uuid(),
  indent_id uuid not null references public.finance_purchase_indents (id) on delete cascade,
  line_order integer not null default 0,
  item_id uuid references public.finance_items (id) on delete set null,
  description text not null,
  quantity numeric(14, 3) not null check (quantity > 0),
  unit text not null default 'nos',
  estimated_rate numeric(14, 2) not null default 0 check (estimated_rate >= 0),
  amount numeric(14, 2) not null default 0
);

create index if not exists finance_purchase_indent_lines_indent_idx
  on public.finance_purchase_indent_lines (indent_id);

-- ---------------------------------------------------------------------------
-- RFQ + vendor quotes
-- ---------------------------------------------------------------------------
create table if not exists public.finance_rfqs (
  id uuid primary key default gen_random_uuid(),
  document_number text not null unique,
  indent_id uuid references public.finance_purchase_indents (id) on delete set null,
  title text not null default '',
  status text not null default 'open'
    check (status in ('draft', 'open', 'closed', 'cancelled', 'converted')),
  notes text not null default '',
  created_by uuid references public.employees (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

drop trigger if exists finance_rfqs_set_updated_at on public.finance_rfqs;
create trigger finance_rfqs_set_updated_at
  before update on public.finance_rfqs
  for each row execute procedure public.set_updated_at();

create table if not exists public.finance_rfq_lines (
  id uuid primary key default gen_random_uuid(),
  rfq_id uuid not null references public.finance_rfqs (id) on delete cascade,
  line_order integer not null default 0,
  item_id uuid references public.finance_items (id) on delete set null,
  description text not null,
  quantity numeric(14, 3) not null check (quantity > 0),
  unit text not null default 'nos'
);

create table if not exists public.finance_rfq_vendors (
  rfq_id uuid not null references public.finance_rfqs (id) on delete cascade,
  vendor_id uuid not null references public.finance_vendors (id) on delete restrict,
  primary key (rfq_id, vendor_id)
);

create table if not exists public.finance_vendor_quotes (
  id uuid primary key default gen_random_uuid(),
  document_number text not null unique,
  rfq_id uuid not null references public.finance_rfqs (id) on delete cascade,
  vendor_id uuid not null references public.finance_vendors (id) on delete restrict,
  quote_date date not null default (timezone('Asia/Kolkata', now()))::date,
  delivery_days integer not null default 0 check (delivery_days >= 0),
  shipping_amount numeric(14, 2) not null default 0,
  notes text not null default '',
  status text not null default 'received'
    check (status in ('received', 'selected', 'rejected')),
  subtotal numeric(14, 2) not null default 0,
  tax_total numeric(14, 2) not null default 0,
  grand_total numeric(14, 2) not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists finance_vendor_quotes_rfq_idx on public.finance_vendor_quotes (rfq_id);

drop trigger if exists finance_vendor_quotes_set_updated_at on public.finance_vendor_quotes;
create trigger finance_vendor_quotes_set_updated_at
  before update on public.finance_vendor_quotes
  for each row execute procedure public.set_updated_at();

create table if not exists public.finance_vendor_quote_lines (
  id uuid primary key default gen_random_uuid(),
  quote_id uuid not null references public.finance_vendor_quotes (id) on delete cascade,
  rfq_line_id uuid references public.finance_rfq_lines (id) on delete set null,
  line_order integer not null default 0,
  description text not null,
  quantity numeric(14, 3) not null check (quantity > 0),
  unit text not null default 'nos',
  rate numeric(14, 2) not null default 0,
  tax_percent numeric(8, 4) not null default 0,
  amount numeric(14, 2) not null default 0,
  tax_amount numeric(14, 2) not null default 0
);

-- ---------------------------------------------------------------------------
-- Purchase orders
-- ---------------------------------------------------------------------------
create table if not exists public.finance_purchase_orders (
  id uuid primary key default gen_random_uuid(),
  document_number text not null unique,
  vendor_id uuid not null references public.finance_vendors (id) on delete restrict,
  indent_id uuid references public.finance_purchase_indents (id) on delete set null,
  rfq_id uuid references public.finance_rfqs (id) on delete set null,
  vendor_quote_id uuid references public.finance_vendor_quotes (id) on delete set null,
  order_date date not null default (timezone('Asia/Kolkata', now()))::date,
  expected_delivery date,
  billing_address text not null default '',
  delivery_address text not null default '',
  payment_terms_days integer not null default 0,
  notes text not null default '',
  status text not null default 'draft'
    check (status in ('draft', 'approved', 'issued', 'partially_received', 'received', 'billed', 'cancelled')),
  subtotal numeric(14, 2) not null default 0,
  tax_total numeric(14, 2) not null default 0,
  grand_total numeric(14, 2) not null default 0,
  created_by uuid references public.employees (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists finance_purchase_orders_vendor_idx on public.finance_purchase_orders (vendor_id);
create index if not exists finance_purchase_orders_status_idx on public.finance_purchase_orders (status);

drop trigger if exists finance_purchase_orders_set_updated_at on public.finance_purchase_orders;
create trigger finance_purchase_orders_set_updated_at
  before update on public.finance_purchase_orders
  for each row execute procedure public.set_updated_at();

create table if not exists public.finance_purchase_order_lines (
  id uuid primary key default gen_random_uuid(),
  purchase_order_id uuid not null references public.finance_purchase_orders (id) on delete cascade,
  line_order integer not null default 0,
  item_id uuid references public.finance_items (id) on delete set null,
  description text not null,
  quantity numeric(14, 3) not null check (quantity > 0),
  unit text not null default 'nos',
  rate numeric(14, 2) not null default 0,
  tax_percent numeric(8, 4) not null default 0,
  amount numeric(14, 2) not null default 0,
  tax_amount numeric(14, 2) not null default 0,
  quantity_received numeric(14, 3) not null default 0,
  quantity_billed numeric(14, 3) not null default 0
);

-- ---------------------------------------------------------------------------
-- Receipts (GRN)
-- ---------------------------------------------------------------------------
create table if not exists public.finance_purchase_receipts (
  id uuid primary key default gen_random_uuid(),
  document_number text not null unique,
  purchase_order_id uuid not null references public.finance_purchase_orders (id) on delete restrict,
  receipt_date date not null default (timezone('Asia/Kolkata', now()))::date,
  notes text not null default '',
  status text not null default 'draft' check (status in ('draft', 'posted', 'cancelled')),
  created_by uuid references public.employees (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

drop trigger if exists finance_purchase_receipts_set_updated_at on public.finance_purchase_receipts;
create trigger finance_purchase_receipts_set_updated_at
  before update on public.finance_purchase_receipts
  for each row execute procedure public.set_updated_at();

create table if not exists public.finance_purchase_receipt_lines (
  id uuid primary key default gen_random_uuid(),
  receipt_id uuid not null references public.finance_purchase_receipts (id) on delete cascade,
  purchase_order_line_id uuid not null references public.finance_purchase_order_lines (id) on delete restrict,
  quantity_received numeric(14, 3) not null check (quantity_received > 0),
  description text not null default ''
);

-- ---------------------------------------------------------------------------
-- Vendor bills
-- ---------------------------------------------------------------------------
create table if not exists public.finance_vendor_bills (
  id uuid primary key default gen_random_uuid(),
  document_number text not null unique,
  vendor_id uuid not null references public.finance_vendors (id) on delete restrict,
  purchase_order_id uuid references public.finance_purchase_orders (id) on delete set null,
  receipt_id uuid references public.finance_purchase_receipts (id) on delete set null,
  bill_date date not null default (timezone('Asia/Kolkata', now()))::date,
  due_date date,
  vendor_invoice_number text,
  notes text not null default '',
  status text not null default 'draft'
    check (status in ('draft', 'posted', 'partially_paid', 'paid', 'void')),
  match_status text not null default 'unchecked'
    check (match_status in ('unchecked', 'matched', 'variance')),
  match_notes text not null default '',
  subtotal numeric(14, 2) not null default 0,
  tax_total numeric(14, 2) not null default 0,
  grand_total numeric(14, 2) not null default 0,
  amount_paid numeric(14, 2) not null default 0,
  journal_id uuid references public.finance_journal_entries (id) on delete set null,
  created_by uuid references public.employees (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists finance_vendor_bills_vendor_idx on public.finance_vendor_bills (vendor_id);
create index if not exists finance_vendor_bills_status_idx on public.finance_vendor_bills (status);

drop trigger if exists finance_vendor_bills_set_updated_at on public.finance_vendor_bills;
create trigger finance_vendor_bills_set_updated_at
  before update on public.finance_vendor_bills
  for each row execute procedure public.set_updated_at();

create table if not exists public.finance_vendor_bill_lines (
  id uuid primary key default gen_random_uuid(),
  bill_id uuid not null references public.finance_vendor_bills (id) on delete cascade,
  purchase_order_line_id uuid references public.finance_purchase_order_lines (id) on delete set null,
  line_order integer not null default 0,
  item_id uuid references public.finance_items (id) on delete set null,
  expense_account_id uuid references public.finance_accounts (id) on delete set null,
  description text not null,
  quantity numeric(14, 3) not null check (quantity > 0),
  unit text not null default 'nos',
  rate numeric(14, 2) not null default 0,
  tax_percent numeric(8, 4) not null default 0,
  amount numeric(14, 2) not null default 0,
  tax_amount numeric(14, 2) not null default 0
);

-- ---------------------------------------------------------------------------
-- Payments made
-- ---------------------------------------------------------------------------
create table if not exists public.finance_vendor_payments (
  id uuid primary key default gen_random_uuid(),
  document_number text not null unique,
  vendor_id uuid not null references public.finance_vendors (id) on delete restrict,
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

drop trigger if exists finance_vendor_payments_set_updated_at on public.finance_vendor_payments;
create trigger finance_vendor_payments_set_updated_at
  before update on public.finance_vendor_payments
  for each row execute procedure public.set_updated_at();

create table if not exists public.finance_vendor_payment_allocations (
  id uuid primary key default gen_random_uuid(),
  payment_id uuid not null references public.finance_vendor_payments (id) on delete cascade,
  bill_id uuid not null references public.finance_vendor_bills (id) on delete restrict,
  amount numeric(14, 2) not null check (amount > 0),
  unique (payment_id, bill_id)
);

-- ---------------------------------------------------------------------------
-- Vendor credits (basic)
-- ---------------------------------------------------------------------------
create table if not exists public.finance_vendor_credits (
  id uuid primary key default gen_random_uuid(),
  document_number text not null unique,
  vendor_id uuid not null references public.finance_vendors (id) on delete restrict,
  bill_id uuid references public.finance_vendor_bills (id) on delete set null,
  credit_date date not null default (timezone('Asia/Kolkata', now()))::date,
  reason text not null default '',
  status text not null default 'draft' check (status in ('draft', 'posted', 'void')),
  subtotal numeric(14, 2) not null default 0,
  tax_total numeric(14, 2) not null default 0,
  grand_total numeric(14, 2) not null default 0,
  journal_id uuid references public.finance_journal_entries (id) on delete set null,
  created_by uuid references public.employees (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

drop trigger if exists finance_vendor_credits_set_updated_at on public.finance_vendor_credits;
create trigger finance_vendor_credits_set_updated_at
  before update on public.finance_vendor_credits
  for each row execute procedure public.set_updated_at();

create table if not exists public.finance_vendor_credit_lines (
  id uuid primary key default gen_random_uuid(),
  credit_id uuid not null references public.finance_vendor_credits (id) on delete cascade,
  line_order integer not null default 0,
  description text not null,
  quantity numeric(14, 3) not null default 1 check (quantity > 0),
  rate numeric(14, 2) not null default 0,
  tax_percent numeric(8, 4) not null default 0,
  amount numeric(14, 2) not null default 0,
  tax_amount numeric(14, 2) not null default 0
);

-- ---------------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------------
alter table public.finance_journal_entries enable row level security;
alter table public.finance_journal_lines enable row level security;
alter table public.finance_purchase_indents enable row level security;
alter table public.finance_purchase_indent_lines enable row level security;
alter table public.finance_rfqs enable row level security;
alter table public.finance_rfq_lines enable row level security;
alter table public.finance_rfq_vendors enable row level security;
alter table public.finance_vendor_quotes enable row level security;
alter table public.finance_vendor_quote_lines enable row level security;
alter table public.finance_purchase_orders enable row level security;
alter table public.finance_purchase_order_lines enable row level security;
alter table public.finance_purchase_receipts enable row level security;
alter table public.finance_purchase_receipt_lines enable row level security;
alter table public.finance_vendor_bills enable row level security;
alter table public.finance_vendor_bill_lines enable row level security;
alter table public.finance_vendor_payments enable row level security;
alter table public.finance_vendor_payment_allocations enable row level security;
alter table public.finance_vendor_credits enable row level security;
alter table public.finance_vendor_credit_lines enable row level security;

-- API uses service role; policies for completeness
do $$
declare
  t text;
begin
  foreach t in array array[
    'finance_journal_entries',
    'finance_journal_lines',
    'finance_purchase_indents',
    'finance_purchase_indent_lines',
    'finance_rfqs',
    'finance_rfq_lines',
    'finance_rfq_vendors',
    'finance_vendor_quotes',
    'finance_vendor_quote_lines',
    'finance_purchase_orders',
    'finance_purchase_order_lines',
    'finance_purchase_receipts',
    'finance_purchase_receipt_lines',
    'finance_vendor_bills',
    'finance_vendor_bill_lines',
    'finance_vendor_payments',
    'finance_vendor_payment_allocations',
    'finance_vendor_credits',
    'finance_vendor_credit_lines'
  ]
  loop
    execute format('drop policy if exists %I_all on public.%I', t, t);
    execute format(
      'create policy %I_all on public.%I for all to authenticated using (
        public.authorize(''finance.purchase.view'')
        or public.authorize(''finance.purchase.manage'')
        or public.authorize(''finance.indent.apply'')
        or public.authorize(''finance.indent.approve'')
      ) with check (
        public.authorize(''finance.purchase.manage'')
        or public.authorize(''finance.indent.apply'')
        or public.authorize(''finance.indent.approve'')
      )',
      t, t
    );
  end loop;
end $$;

notify pgrst, 'reload schema';
