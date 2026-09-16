-- Finance Phase 0: org profile, COA, tax, parties, items, number series, permissions.
-- Additive only — does not alter payroll companies or organization_settings.

insert into public.permissions (code, description) values
  ('finance.org.manage', 'Manage finance organization profile and Getting Started'),
  ('finance.coa.view', 'View chart of accounts'),
  ('finance.coa.manage', 'Manage chart of accounts'),
  ('finance.tax.manage', 'Manage GST/TDS tax masters'),
  ('finance.parties.manage', 'Manage customers and vendors'),
  ('finance.items.manage', 'Manage finance items (goods/services)'),
  ('finance.series.manage', 'Manage document number series')
on conflict (code) do nothing;

insert into public.role_permissions (role_id, permission_id)
select r.id, p.id
from public.roles r
cross join public.permissions p
where r.code = 'FINANCE_MANAGER'
  and p.code in (
    'finance.org.manage',
    'finance.coa.view',
    'finance.coa.manage',
    'finance.tax.manage',
    'finance.parties.manage',
    'finance.items.manage',
    'finance.series.manage'
  )
on conflict do nothing;

-- ---------------------------------------------------------------------------
-- Organization (singleton books entity — separate from payroll companies)
-- ---------------------------------------------------------------------------
create table if not exists public.finance_organizations (
  id uuid primary key default gen_random_uuid(),
  legal_name text not null default '',
  trade_name text not null default '',
  cin text,
  pan text,
  gstin text,
  industry text,
  country_code text not null default 'IN',
  state_code text,
  state_name text,
  address_line1 text not null default '',
  address_line2 text not null default '',
  city text not null default '',
  postal_code text not null default '',
  base_currency text not null default 'INR',
  language text not null default 'en',
  time_zone text not null default 'Asia/Kolkata',
  fiscal_year_start_month smallint not null default 4
    check (fiscal_year_start_month between 1 and 12),
  gst_registered boolean not null default false,
  gst_registration_type text
    check (gst_registration_type is null or gst_registration_type in ('regular', 'composition', 'unregistered')),
  setup_completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

insert into public.finance_organizations (
  id, legal_name, trade_name, country_code, base_currency, language, time_zone, fiscal_year_start_month, gst_registered
) values (
  '00000000-0000-4000-8000-000000000020',
  'Insyra Private Limited',
  'Insyra',
  'IN',
  'INR',
  'en',
  'Asia/Kolkata',
  4,
  false
)
on conflict (id) do nothing;

drop trigger if exists finance_organizations_set_updated_at on public.finance_organizations;
create trigger finance_organizations_set_updated_at
  before update on public.finance_organizations
  for each row execute procedure public.set_updated_at();

-- ---------------------------------------------------------------------------
-- Chart of accounts
-- ---------------------------------------------------------------------------
create table if not exists public.finance_accounts (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  name text not null,
  account_type text not null check (account_type in ('asset', 'liability', 'equity', 'income', 'expense')),
  system_role text unique,
  is_system boolean not null default false,
  is_active boolean not null default true,
  parent_id uuid references public.finance_accounts (id) on delete restrict,
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists finance_accounts_type_idx on public.finance_accounts (account_type, sort_order);

drop trigger if exists finance_accounts_set_updated_at on public.finance_accounts;
create trigger finance_accounts_set_updated_at
  before update on public.finance_accounts
  for each row execute procedure public.set_updated_at();

insert into public.finance_accounts (code, name, account_type, system_role, is_system, sort_order) values
  ('1000', 'Cash', 'asset', 'cash', true, 10),
  ('1010', 'Bank', 'asset', 'bank', true, 20),
  ('1100', 'Accounts Receivable', 'asset', 'accounts_receivable', true, 30),
  ('1200', 'Input CGST', 'asset', 'input_cgst', true, 40),
  ('1210', 'Input SGST', 'asset', 'input_sgst', true, 50),
  ('1220', 'Input IGST', 'asset', 'input_igst', true, 60),
  ('2000', 'Accounts Payable', 'liability', 'accounts_payable', true, 10),
  ('2100', 'Output CGST', 'liability', 'output_cgst', true, 20),
  ('2110', 'Output SGST', 'liability', 'output_sgst', true, 30),
  ('2120', 'Output IGST', 'liability', 'output_igst', true, 40),
  ('2200', 'TDS Payable', 'liability', 'tds_payable', true, 50),
  ('3000', 'Capital', 'equity', null, true, 10),
  ('3100', 'Retained Earnings', 'equity', null, true, 20),
  ('4000', 'Sales', 'income', 'sales', true, 10),
  ('5000', 'Cost of Goods Sold', 'expense', 'cogs', true, 10),
  ('5100', 'Purchase Expense', 'expense', 'purchase', true, 20),
  ('5200', 'Office Expenses', 'expense', null, true, 30),
  ('5300', 'Salaries', 'expense', null, true, 40),
  ('5400', 'Rent', 'expense', null, true, 50)
on conflict (code) do nothing;

-- ---------------------------------------------------------------------------
-- Tax masters
-- ---------------------------------------------------------------------------
create table if not exists public.finance_tax_rates (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  rate_percent numeric(8, 4) not null check (rate_percent >= 0),
  tax_type text not null check (tax_type in ('cgst', 'sgst', 'igst', 'cess', 'tds')),
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (name, tax_type)
);

drop trigger if exists finance_tax_rates_set_updated_at on public.finance_tax_rates;
create trigger finance_tax_rates_set_updated_at
  before update on public.finance_tax_rates
  for each row execute procedure public.set_updated_at();

create table if not exists public.finance_tax_groups (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

drop trigger if exists finance_tax_groups_set_updated_at on public.finance_tax_groups;
create trigger finance_tax_groups_set_updated_at
  before update on public.finance_tax_groups
  for each row execute procedure public.set_updated_at();

create table if not exists public.finance_tax_group_rates (
  tax_group_id uuid not null references public.finance_tax_groups (id) on delete cascade,
  tax_rate_id uuid not null references public.finance_tax_rates (id) on delete restrict,
  primary key (tax_group_id, tax_rate_id)
);

create table if not exists public.finance_tds_rates (
  id uuid primary key default gen_random_uuid(),
  section text not null,
  name text not null,
  rate_percent numeric(8, 4) not null check (rate_percent >= 0),
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (section, name)
);

drop trigger if exists finance_tds_rates_set_updated_at on public.finance_tds_rates;
create trigger finance_tds_rates_set_updated_at
  before update on public.finance_tds_rates
  for each row execute procedure public.set_updated_at();

-- Seed GST rates + groups (idempotent via fixed ids)
insert into public.finance_tax_rates (id, name, rate_percent, tax_type) values
  ('00000000-0000-4000-8100-000000000001', 'CGST 0%', 0, 'cgst'),
  ('00000000-0000-4000-8100-000000000002', 'SGST 0%', 0, 'sgst'),
  ('00000000-0000-4000-8100-000000000003', 'IGST 0%', 0, 'igst'),
  ('00000000-0000-4000-8100-000000000004', 'CGST 2.5%', 2.5, 'cgst'),
  ('00000000-0000-4000-8100-000000000005', 'SGST 2.5%', 2.5, 'sgst'),
  ('00000000-0000-4000-8100-000000000006', 'IGST 5%', 5, 'igst'),
  ('00000000-0000-4000-8100-000000000007', 'CGST 6%', 6, 'cgst'),
  ('00000000-0000-4000-8100-000000000008', 'SGST 6%', 6, 'sgst'),
  ('00000000-0000-4000-8100-000000000009', 'IGST 12%', 12, 'igst'),
  ('00000000-0000-4000-8100-00000000000a', 'CGST 9%', 9, 'cgst'),
  ('00000000-0000-4000-8100-00000000000b', 'SGST 9%', 9, 'sgst'),
  ('00000000-0000-4000-8100-00000000000c', 'IGST 18%', 18, 'igst'),
  ('00000000-0000-4000-8100-00000000000d', 'CGST 14%', 14, 'cgst'),
  ('00000000-0000-4000-8100-00000000000e', 'SGST 14%', 14, 'sgst'),
  ('00000000-0000-4000-8100-00000000000f', 'IGST 28%', 28, 'igst')
on conflict (id) do nothing;

insert into public.finance_tax_groups (id, name) values
  ('00000000-0000-4000-8200-000000000001', 'GST 0%'),
  ('00000000-0000-4000-8200-000000000002', 'GST 5%'),
  ('00000000-0000-4000-8200-000000000003', 'GST 12%'),
  ('00000000-0000-4000-8200-000000000004', 'GST 18%'),
  ('00000000-0000-4000-8200-000000000005', 'GST 28%'),
  ('00000000-0000-4000-8200-000000000006', 'IGST 0%'),
  ('00000000-0000-4000-8200-000000000007', 'IGST 5%'),
  ('00000000-0000-4000-8200-000000000008', 'IGST 12%'),
  ('00000000-0000-4000-8200-000000000009', 'IGST 18%'),
  ('00000000-0000-4000-8200-00000000000a', 'IGST 28%')
on conflict (id) do nothing;

insert into public.finance_tax_group_rates (tax_group_id, tax_rate_id) values
  ('00000000-0000-4000-8200-000000000001', '00000000-0000-4000-8100-000000000001'),
  ('00000000-0000-4000-8200-000000000001', '00000000-0000-4000-8100-000000000002'),
  ('00000000-0000-4000-8200-000000000002', '00000000-0000-4000-8100-000000000004'),
  ('00000000-0000-4000-8200-000000000002', '00000000-0000-4000-8100-000000000005'),
  ('00000000-0000-4000-8200-000000000003', '00000000-0000-4000-8100-000000000007'),
  ('00000000-0000-4000-8200-000000000003', '00000000-0000-4000-8100-000000000008'),
  ('00000000-0000-4000-8200-000000000004', '00000000-0000-4000-8100-00000000000a'),
  ('00000000-0000-4000-8200-000000000004', '00000000-0000-4000-8100-00000000000b'),
  ('00000000-0000-4000-8200-000000000005', '00000000-0000-4000-8100-00000000000d'),
  ('00000000-0000-4000-8200-000000000005', '00000000-0000-4000-8100-00000000000e'),
  ('00000000-0000-4000-8200-000000000006', '00000000-0000-4000-8100-000000000003'),
  ('00000000-0000-4000-8200-000000000007', '00000000-0000-4000-8100-000000000006'),
  ('00000000-0000-4000-8200-000000000008', '00000000-0000-4000-8100-000000000009'),
  ('00000000-0000-4000-8200-000000000009', '00000000-0000-4000-8100-00000000000c'),
  ('00000000-0000-4000-8200-00000000000a', '00000000-0000-4000-8100-00000000000f')
on conflict do nothing;

insert into public.finance_tds_rates (section, name, rate_percent) values
  ('194C', 'Contractors', 1),
  ('194J', 'Professional fees', 10),
  ('194H', 'Commission / brokerage', 5),
  ('194I', 'Rent', 10)
on conflict (section, name) do nothing;

-- ---------------------------------------------------------------------------
-- Parties
-- ---------------------------------------------------------------------------
create table if not exists public.finance_customers (
  id uuid primary key default gen_random_uuid(),
  display_name text not null,
  company_name text not null default '',
  email text,
  phone text,
  gstin text,
  pan text,
  state_code text,
  state_name text,
  billing_address text not null default '',
  shipping_address text not null default '',
  payment_terms_days integer not null default 0 check (payment_terms_days >= 0),
  currency_code text not null default 'INR',
  status text not null default 'active' check (status in ('active', 'inactive')),
  notes text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists finance_customers_name_idx on public.finance_customers (display_name);

drop trigger if exists finance_customers_set_updated_at on public.finance_customers;
create trigger finance_customers_set_updated_at
  before update on public.finance_customers
  for each row execute procedure public.set_updated_at();

create table if not exists public.finance_vendors (
  id uuid primary key default gen_random_uuid(),
  display_name text not null,
  company_name text not null default '',
  email text,
  phone text,
  gstin text,
  pan text,
  state_code text,
  state_name text,
  billing_address text not null default '',
  payment_terms_days integer not null default 0 check (payment_terms_days >= 0),
  currency_code text not null default 'INR',
  status text not null default 'active' check (status in ('active', 'inactive')),
  notes text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists finance_vendors_name_idx on public.finance_vendors (display_name);

drop trigger if exists finance_vendors_set_updated_at on public.finance_vendors;
create trigger finance_vendors_set_updated_at
  before update on public.finance_vendors
  for each row execute procedure public.set_updated_at();

-- ---------------------------------------------------------------------------
-- Items
-- ---------------------------------------------------------------------------
create table if not exists public.finance_items (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  name text not null,
  item_type text not null check (item_type in ('goods', 'service')),
  hsn_sac text,
  unit text not null default 'nos',
  sale_rate numeric(14, 2) not null default 0 check (sale_rate >= 0),
  purchase_rate numeric(14, 2) not null default 0 check (purchase_rate >= 0),
  income_account_id uuid references public.finance_accounts (id) on delete restrict,
  expense_account_id uuid references public.finance_accounts (id) on delete restrict,
  tax_group_id uuid references public.finance_tax_groups (id) on delete set null,
  description text not null default '',
  status text not null default 'active' check (status in ('active', 'inactive')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists finance_items_name_idx on public.finance_items (name);

drop trigger if exists finance_items_set_updated_at on public.finance_items;
create trigger finance_items_set_updated_at
  before update on public.finance_items
  for each row execute procedure public.set_updated_at();

-- ---------------------------------------------------------------------------
-- Number series
-- ---------------------------------------------------------------------------
create table if not exists public.finance_number_series (
  id uuid primary key default gen_random_uuid(),
  document_type text not null,
  prefix text not null,
  pad_length integer not null default 4 check (pad_length between 1 and 10),
  next_number bigint not null default 1 check (next_number >= 1),
  fiscal_year_label text not null default '',
  reset_yearly boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (document_type, fiscal_year_label)
);

drop trigger if exists finance_number_series_set_updated_at on public.finance_number_series;
create trigger finance_number_series_set_updated_at
  before update on public.finance_number_series
  for each row execute procedure public.set_updated_at();

insert into public.finance_number_series (document_type, prefix, pad_length, next_number, fiscal_year_label, reset_yearly) values
  ('indent', 'IND', 4, 1, '2026-27', true),
  ('purchase_order', 'PO', 4, 1, '2026-27', true),
  ('bill', 'BILL', 4, 1, '2026-27', true),
  ('payment_made', 'PAY', 4, 1, '2026-27', true),
  ('quote', 'QT', 4, 1, '2026-27', true),
  ('sales_order', 'SO', 4, 1, '2026-27', true),
  ('delivery_note', 'DN', 4, 1, '2026-27', true),
  ('invoice', 'INV', 4, 1, '2026-27', true),
  ('payment_received', 'RCV', 4, 1, '2026-27', true),
  ('credit_note', 'CN', 4, 1, '2026-27', true),
  ('journal', 'JV', 4, 1, '2026-27', true),
  ('expense', 'EXP', 4, 1, '2026-27', true)
on conflict (document_type, fiscal_year_label) do nothing;

-- ---------------------------------------------------------------------------
-- RLS (API uses service role; policies mirror other modules for completeness)
-- ---------------------------------------------------------------------------
alter table public.finance_organizations enable row level security;
alter table public.finance_accounts enable row level security;
alter table public.finance_tax_rates enable row level security;
alter table public.finance_tax_groups enable row level security;
alter table public.finance_tax_group_rates enable row level security;
alter table public.finance_tds_rates enable row level security;
alter table public.finance_customers enable row level security;
alter table public.finance_vendors enable row level security;
alter table public.finance_items enable row level security;
alter table public.finance_number_series enable row level security;

drop policy if exists finance_organizations_all on public.finance_organizations;
create policy finance_organizations_all on public.finance_organizations
  for all to authenticated
  using (public.authorize('finance.org.manage'))
  with check (public.authorize('finance.org.manage'));

drop policy if exists finance_accounts_select on public.finance_accounts;
create policy finance_accounts_select on public.finance_accounts
  for select to authenticated
  using (public.authorize('finance.coa.view') or public.authorize('finance.coa.manage'));

drop policy if exists finance_accounts_write on public.finance_accounts;
create policy finance_accounts_write on public.finance_accounts
  for all to authenticated
  using (public.authorize('finance.coa.manage'))
  with check (public.authorize('finance.coa.manage'));

drop policy if exists finance_tax_rates_all on public.finance_tax_rates;
create policy finance_tax_rates_all on public.finance_tax_rates
  for all to authenticated
  using (public.authorize('finance.tax.manage') or public.authorize('finance.items.manage'))
  with check (public.authorize('finance.tax.manage'));

drop policy if exists finance_tax_groups_all on public.finance_tax_groups;
create policy finance_tax_groups_all on public.finance_tax_groups
  for all to authenticated
  using (public.authorize('finance.tax.manage') or public.authorize('finance.items.manage'))
  with check (public.authorize('finance.tax.manage'));

drop policy if exists finance_tax_group_rates_all on public.finance_tax_group_rates;
create policy finance_tax_group_rates_all on public.finance_tax_group_rates
  for all to authenticated
  using (public.authorize('finance.tax.manage') or public.authorize('finance.items.manage'))
  with check (public.authorize('finance.tax.manage'));

drop policy if exists finance_tds_rates_all on public.finance_tds_rates;
create policy finance_tds_rates_all on public.finance_tds_rates
  for all to authenticated
  using (public.authorize('finance.tax.manage'))
  with check (public.authorize('finance.tax.manage'));

drop policy if exists finance_customers_all on public.finance_customers;
create policy finance_customers_all on public.finance_customers
  for all to authenticated
  using (public.authorize('finance.parties.manage'))
  with check (public.authorize('finance.parties.manage'));

drop policy if exists finance_vendors_all on public.finance_vendors;
create policy finance_vendors_all on public.finance_vendors
  for all to authenticated
  using (public.authorize('finance.parties.manage'))
  with check (public.authorize('finance.parties.manage'));

drop policy if exists finance_items_all on public.finance_items;
create policy finance_items_all on public.finance_items
  for all to authenticated
  using (public.authorize('finance.items.manage'))
  with check (public.authorize('finance.items.manage'));

drop policy if exists finance_number_series_all on public.finance_number_series;
create policy finance_number_series_all on public.finance_number_series
  for all to authenticated
  using (public.authorize('finance.series.manage') or public.authorize('finance.org.manage'))
  with check (public.authorize('finance.series.manage'));

notify pgrst, 'reload schema';
