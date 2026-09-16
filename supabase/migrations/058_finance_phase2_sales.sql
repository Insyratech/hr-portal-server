-- Finance Phase 2: sales documents (quote → cash). Additive; depends on 056 + 057.

insert into public.permissions (code, description) values
  ('finance.sales.view', 'View sales documents'),
  ('finance.sales.manage', 'Create and manage quotes, orders, deliveries, invoices, receipts, credit notes')
on conflict (code) do nothing;

insert into public.role_permissions (role_id, permission_id)
select r.id, p.id
from public.roles r
cross join public.permissions p
where r.code = 'FINANCE_MANAGER'
  and p.code in ('finance.sales.view', 'finance.sales.manage')
on conflict do nothing;

-- ---------------------------------------------------------------------------
-- Quotes
-- ---------------------------------------------------------------------------
create table if not exists public.finance_sales_quotes (
  id uuid primary key default gen_random_uuid(),
  document_number text not null unique,
  customer_id uuid not null references public.finance_customers (id) on delete restrict,
  quote_date date not null default (timezone('Asia/Kolkata', now()))::date,
  expiry_date date,
  status text not null default 'draft'
    check (status in ('draft', 'sent', 'accepted', 'declined', 'expired', 'converted', 'cancelled')),
  notes text not null default '',
  terms text not null default '',
  subtotal numeric(14, 2) not null default 0,
  tax_total numeric(14, 2) not null default 0,
  grand_total numeric(14, 2) not null default 0,
  created_by uuid references public.employees (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists finance_sales_quotes_customer_idx on public.finance_sales_quotes (customer_id);
create index if not exists finance_sales_quotes_status_idx on public.finance_sales_quotes (status);

drop trigger if exists finance_sales_quotes_set_updated_at on public.finance_sales_quotes;
create trigger finance_sales_quotes_set_updated_at
  before update on public.finance_sales_quotes
  for each row execute procedure public.set_updated_at();

create table if not exists public.finance_sales_quote_lines (
  id uuid primary key default gen_random_uuid(),
  quote_id uuid not null references public.finance_sales_quotes (id) on delete cascade,
  line_order integer not null default 0,
  item_id uuid references public.finance_items (id) on delete set null,
  description text not null,
  quantity numeric(14, 3) not null check (quantity > 0),
  unit text not null default 'nos',
  rate numeric(14, 2) not null default 0,
  tax_percent numeric(8, 4) not null default 0,
  amount numeric(14, 2) not null default 0,
  tax_amount numeric(14, 2) not null default 0
);

-- ---------------------------------------------------------------------------
-- Sales orders
-- ---------------------------------------------------------------------------
create table if not exists public.finance_sales_orders (
  id uuid primary key default gen_random_uuid(),
  document_number text not null unique,
  customer_id uuid not null references public.finance_customers (id) on delete restrict,
  quote_id uuid references public.finance_sales_quotes (id) on delete set null,
  order_date date not null default (timezone('Asia/Kolkata', now()))::date,
  expected_delivery date,
  billing_address text not null default '',
  shipping_address text not null default '',
  notes text not null default '',
  status text not null default 'draft'
    check (status in ('draft', 'confirmed', 'partially_delivered', 'delivered', 'partially_invoiced', 'invoiced', 'cancelled')),
  subtotal numeric(14, 2) not null default 0,
  tax_total numeric(14, 2) not null default 0,
  grand_total numeric(14, 2) not null default 0,
  created_by uuid references public.employees (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists finance_sales_orders_customer_idx on public.finance_sales_orders (customer_id);
create index if not exists finance_sales_orders_status_idx on public.finance_sales_orders (status);

drop trigger if exists finance_sales_orders_set_updated_at on public.finance_sales_orders;
create trigger finance_sales_orders_set_updated_at
  before update on public.finance_sales_orders
  for each row execute procedure public.set_updated_at();

create table if not exists public.finance_sales_order_lines (
  id uuid primary key default gen_random_uuid(),
  sales_order_id uuid not null references public.finance_sales_orders (id) on delete cascade,
  line_order integer not null default 0,
  item_id uuid references public.finance_items (id) on delete set null,
  description text not null,
  quantity numeric(14, 3) not null check (quantity > 0),
  unit text not null default 'nos',
  rate numeric(14, 2) not null default 0,
  tax_percent numeric(8, 4) not null default 0,
  amount numeric(14, 2) not null default 0,
  tax_amount numeric(14, 2) not null default 0,
  quantity_delivered numeric(14, 3) not null default 0,
  quantity_invoiced numeric(14, 3) not null default 0
);

-- ---------------------------------------------------------------------------
-- Delivery notes
-- ---------------------------------------------------------------------------
create table if not exists public.finance_delivery_notes (
  id uuid primary key default gen_random_uuid(),
  document_number text not null unique,
  sales_order_id uuid not null references public.finance_sales_orders (id) on delete restrict,
  customer_id uuid not null references public.finance_customers (id) on delete restrict,
  delivery_date date not null default (timezone('Asia/Kolkata', now()))::date,
  notes text not null default '',
  status text not null default 'draft' check (status in ('draft', 'delivered', 'cancelled')),
  created_by uuid references public.employees (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

drop trigger if exists finance_delivery_notes_set_updated_at on public.finance_delivery_notes;
create trigger finance_delivery_notes_set_updated_at
  before update on public.finance_delivery_notes
  for each row execute procedure public.set_updated_at();

create table if not exists public.finance_delivery_note_lines (
  id uuid primary key default gen_random_uuid(),
  delivery_note_id uuid not null references public.finance_delivery_notes (id) on delete cascade,
  sales_order_line_id uuid not null references public.finance_sales_order_lines (id) on delete restrict,
  quantity_delivered numeric(14, 3) not null check (quantity_delivered > 0),
  description text not null default ''
);

-- ---------------------------------------------------------------------------
-- Invoices
-- ---------------------------------------------------------------------------
create table if not exists public.finance_invoices (
  id uuid primary key default gen_random_uuid(),
  document_number text not null unique,
  customer_id uuid not null references public.finance_customers (id) on delete restrict,
  sales_order_id uuid references public.finance_sales_orders (id) on delete set null,
  delivery_note_id uuid references public.finance_delivery_notes (id) on delete set null,
  quote_id uuid references public.finance_sales_quotes (id) on delete set null,
  invoice_date date not null default (timezone('Asia/Kolkata', now()))::date,
  due_date date,
  notes text not null default '',
  status text not null default 'draft'
    check (status in ('draft', 'sent', 'overdue', 'partially_paid', 'paid', 'void')),
  subtotal numeric(14, 2) not null default 0,
  tax_total numeric(14, 2) not null default 0,
  grand_total numeric(14, 2) not null default 0,
  amount_paid numeric(14, 2) not null default 0,
  journal_id uuid references public.finance_journal_entries (id) on delete set null,
  created_by uuid references public.employees (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists finance_invoices_customer_idx on public.finance_invoices (customer_id);
create index if not exists finance_invoices_status_idx on public.finance_invoices (status);

drop trigger if exists finance_invoices_set_updated_at on public.finance_invoices;
create trigger finance_invoices_set_updated_at
  before update on public.finance_invoices
  for each row execute procedure public.set_updated_at();

create table if not exists public.finance_invoice_lines (
  id uuid primary key default gen_random_uuid(),
  invoice_id uuid not null references public.finance_invoices (id) on delete cascade,
  sales_order_line_id uuid references public.finance_sales_order_lines (id) on delete set null,
  line_order integer not null default 0,
  item_id uuid references public.finance_items (id) on delete set null,
  income_account_id uuid references public.finance_accounts (id) on delete set null,
  description text not null,
  quantity numeric(14, 3) not null check (quantity > 0),
  unit text not null default 'nos',
  rate numeric(14, 2) not null default 0,
  tax_percent numeric(8, 4) not null default 0,
  amount numeric(14, 2) not null default 0,
  tax_amount numeric(14, 2) not null default 0
);

-- ---------------------------------------------------------------------------
-- Payments received
-- ---------------------------------------------------------------------------
create table if not exists public.finance_customer_payments (
  id uuid primary key default gen_random_uuid(),
  document_number text not null unique,
  customer_id uuid not null references public.finance_customers (id) on delete restrict,
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

drop trigger if exists finance_customer_payments_set_updated_at on public.finance_customer_payments;
create trigger finance_customer_payments_set_updated_at
  before update on public.finance_customer_payments
  for each row execute procedure public.set_updated_at();

create table if not exists public.finance_customer_payment_allocations (
  id uuid primary key default gen_random_uuid(),
  payment_id uuid not null references public.finance_customer_payments (id) on delete cascade,
  invoice_id uuid not null references public.finance_invoices (id) on delete restrict,
  amount numeric(14, 2) not null check (amount > 0),
  unique (payment_id, invoice_id)
);

-- ---------------------------------------------------------------------------
-- Credit notes
-- ---------------------------------------------------------------------------
create table if not exists public.finance_credit_notes (
  id uuid primary key default gen_random_uuid(),
  document_number text not null unique,
  customer_id uuid not null references public.finance_customers (id) on delete restrict,
  invoice_id uuid references public.finance_invoices (id) on delete set null,
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

drop trigger if exists finance_credit_notes_set_updated_at on public.finance_credit_notes;
create trigger finance_credit_notes_set_updated_at
  before update on public.finance_credit_notes
  for each row execute procedure public.set_updated_at();

create table if not exists public.finance_credit_note_lines (
  id uuid primary key default gen_random_uuid(),
  credit_note_id uuid not null references public.finance_credit_notes (id) on delete cascade,
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
alter table public.finance_sales_quotes enable row level security;
alter table public.finance_sales_quote_lines enable row level security;
alter table public.finance_sales_orders enable row level security;
alter table public.finance_sales_order_lines enable row level security;
alter table public.finance_delivery_notes enable row level security;
alter table public.finance_delivery_note_lines enable row level security;
alter table public.finance_invoices enable row level security;
alter table public.finance_invoice_lines enable row level security;
alter table public.finance_customer_payments enable row level security;
alter table public.finance_customer_payment_allocations enable row level security;
alter table public.finance_credit_notes enable row level security;
alter table public.finance_credit_note_lines enable row level security;

do $$
declare
  t text;
begin
  foreach t in array array[
    'finance_sales_quotes',
    'finance_sales_quote_lines',
    'finance_sales_orders',
    'finance_sales_order_lines',
    'finance_delivery_notes',
    'finance_delivery_note_lines',
    'finance_invoices',
    'finance_invoice_lines',
    'finance_customer_payments',
    'finance_customer_payment_allocations',
    'finance_credit_notes',
    'finance_credit_note_lines'
  ]
  loop
    execute format('drop policy if exists %I_all on public.%I', t, t);
    execute format(
      'create policy %I_all on public.%I for all to authenticated using (
        public.authorize(''finance.sales.view'')
        or public.authorize(''finance.sales.manage'')
      ) with check (
        public.authorize(''finance.sales.manage'')
      )',
      t, t
    );
  end loop;
end $$;

notify pgrst, 'reload schema';
