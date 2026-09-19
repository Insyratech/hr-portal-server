-- Quote enrichment, customer structured addresses + history, quote versions (additive).

-- ---------------------------------------------------------------------------
-- Customers: structured bill-to / ship-to (keep legacy text columns in sync)
-- ---------------------------------------------------------------------------
alter table public.finance_customers
  add column if not exists billing_line1 text not null default '',
  add column if not exists billing_line2 text not null default '',
  add column if not exists billing_city text not null default '',
  add column if not exists billing_postal_code text not null default '',
  add column if not exists billing_country text not null default 'India',
  add column if not exists shipping_line1 text not null default '',
  add column if not exists shipping_line2 text not null default '',
  add column if not exists shipping_city text not null default '',
  add column if not exists shipping_state_code text,
  add column if not exists shipping_state_name text,
  add column if not exists shipping_postal_code text not null default '',
  add column if not exists shipping_country text not null default 'India',
  add column if not exists ship_to_contact_name text not null default '',
  add column if not exists ship_to_company_name text not null default '';

-- Backfill structured billing from free-text when empty
update public.finance_customers
set billing_line1 = billing_address
where coalesce(billing_line1, '') = '' and coalesce(billing_address, '') <> '';

update public.finance_customers
set shipping_line1 = shipping_address
where coalesce(shipping_line1, '') = '' and coalesce(shipping_address, '') <> '';

create table if not exists public.finance_customer_change_history (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid not null references public.finance_customers (id) on delete cascade,
  field_name text not null,
  old_value text,
  new_value text,
  changed_by uuid references public.employees (id) on delete set null,
  changed_at timestamptz not null default now()
);

create index if not exists finance_customer_change_history_customer_idx
  on public.finance_customer_change_history (customer_id, changed_at desc);

alter table public.finance_customer_change_history enable row level security;

drop policy if exists finance_customer_change_history_all on public.finance_customer_change_history;
create policy finance_customer_change_history_all on public.finance_customer_change_history
  for all to authenticated
  using (public.authorize('finance.parties.manage'))
  with check (public.authorize('finance.parties.manage'));

grant all on public.finance_customer_change_history to service_role;

-- ---------------------------------------------------------------------------
-- Quotes: letterhead, snapshots, subject, version counter
-- ---------------------------------------------------------------------------
alter table public.finance_sales_quotes
  add column if not exists subject text not null default '',
  add column if not exists reference_text text not null default '',
  add column if not exists place_of_supply text not null default '',
  add column if not exists org_gst_profile_id uuid references public.finance_org_gst_profiles (id) on delete set null,
  add column if not exists billing_address_snapshot text not null default '',
  add column if not exists shipping_address_snapshot text not null default '',
  add column if not exists customer_gstin_snapshot text,
  add column if not exists ship_to_name text not null default '',
  add column if not exists version_number integer not null default 1;

alter table public.finance_sales_quote_lines
  add column if not exists catalog_no text not null default '',
  add column if not exists hsn_sac text not null default '';

create table if not exists public.finance_sales_quote_versions (
  id uuid primary key default gen_random_uuid(),
  quote_id uuid not null references public.finance_sales_quotes (id) on delete cascade,
  version_number integer not null,
  change_note text not null default '',
  snapshot jsonb not null,
  created_by uuid references public.employees (id) on delete set null,
  created_at timestamptz not null default now(),
  unique (quote_id, version_number)
);

create index if not exists finance_sales_quote_versions_quote_idx
  on public.finance_sales_quote_versions (quote_id, version_number desc);

alter table public.finance_sales_quote_versions enable row level security;

drop policy if exists finance_sales_quote_versions_all on public.finance_sales_quote_versions;
create policy finance_sales_quote_versions_all on public.finance_sales_quote_versions
  for all to authenticated
  using (
    public.authorize('finance.sales.view')
    or public.authorize('finance.sales.manage')
  )
  with check (public.authorize('finance.sales.manage'));

grant all on public.finance_sales_quote_versions to service_role;

notify pgrst, 'reload schema';
