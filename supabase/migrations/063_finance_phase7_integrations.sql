-- Finance Phase 7: e-Invoice / e-Way / GSTN sync / payment gateway & bank-feed config.
-- Additive; depends on 056–062. Default GSP mode is sandbox (no live IRP calls).

insert into public.permissions (code, description) values
  ('finance.integrations.view', 'View e-invoice, e-way, GSTN sync, and payment integration status'),
  ('finance.integrations.manage', 'Generate sandbox/live IRN, e-way bills, GSTN sync jobs, configure gateways')
on conflict (code) do nothing;

insert into public.role_permissions (role_id, permission_id)
select r.id, p.id
from public.roles r
cross join public.permissions p
where r.code = 'FINANCE_MANAGER'
  and p.code in ('finance.integrations.view', 'finance.integrations.manage')
on conflict do nothing;

-- ---------------------------------------------------------------------------
-- E-invoices (IRN)
-- ---------------------------------------------------------------------------
create table if not exists public.finance_einvoices (
  id uuid primary key default gen_random_uuid(),
  invoice_id uuid not null unique references public.finance_invoices (id) on delete restrict,
  provider_mode text not null default 'sandbox' check (provider_mode in ('sandbox', 'live')),
  status text not null default 'pending'
    check (status in ('pending', 'generated', 'cancelled', 'failed')),
  irn text,
  ack_number text,
  ack_date timestamptz,
  signed_qr text,
  signed_invoice text,
  irp_status text not null default '',
  cancel_reason text not null default '',
  error_code text not null default '',
  error_message text not null default '',
  request_payload jsonb,
  response_payload jsonb,
  generated_at timestamptz,
  generated_by uuid references public.employees (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists finance_einvoices_status_idx on public.finance_einvoices (status);

drop trigger if exists finance_einvoices_set_updated_at on public.finance_einvoices;
create trigger finance_einvoices_set_updated_at
  before update on public.finance_einvoices
  for each row execute procedure public.set_updated_at();

-- ---------------------------------------------------------------------------
-- E-Way bills
-- ---------------------------------------------------------------------------
create table if not exists public.finance_eway_bills (
  id uuid primary key default gen_random_uuid(),
  source_type text not null check (source_type in ('invoice', 'delivery_note')),
  source_id uuid not null,
  provider_mode text not null default 'sandbox' check (provider_mode in ('sandbox', 'live')),
  status text not null default 'pending'
    check (status in ('pending', 'generated', 'cancelled', 'failed')),
  ewb_number text,
  transporter_id text not null default '',
  transporter_name text not null default '',
  vehicle_number text not null default '',
  transport_mode text not null default 'road'
    check (transport_mode in ('road', 'rail', 'air', 'ship')),
  distance_km numeric(10, 2) not null default 0,
  from_place text not null default '',
  to_place text not null default '',
  valid_until date,
  error_code text not null default '',
  error_message text not null default '',
  request_payload jsonb,
  response_payload jsonb,
  generated_at timestamptz,
  generated_by uuid references public.employees (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (source_type, source_id)
);

drop trigger if exists finance_eway_bills_set_updated_at on public.finance_eway_bills;
create trigger finance_eway_bills_set_updated_at
  before update on public.finance_eway_bills
  for each row execute procedure public.set_updated_at();

-- ---------------------------------------------------------------------------
-- GSTN sync jobs (GSTR-1 push / 2B pull)
-- ---------------------------------------------------------------------------
create table if not exists public.finance_gstn_sync_jobs (
  id uuid primary key default gen_random_uuid(),
  job_type text not null check (job_type in ('gstr1_push', 'gstr2b_pull')),
  period_year integer not null,
  period_month integer not null check (period_month >= 1 and period_month <= 12),
  provider_mode text not null default 'sandbox' check (provider_mode in ('sandbox', 'live')),
  status text not null default 'queued'
    check (status in ('queued', 'running', 'succeeded', 'failed')),
  row_count integer not null default 0,
  reference_id text not null default '',
  error_message text not null default '',
  request_payload jsonb,
  response_payload jsonb,
  created_by uuid references public.employees (id) on delete set null,
  started_at timestamptz,
  finished_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

drop trigger if exists finance_gstn_sync_jobs_set_updated_at on public.finance_gstn_sync_jobs;
create trigger finance_gstn_sync_jobs_set_updated_at
  before update on public.finance_gstn_sync_jobs
  for each row execute procedure public.set_updated_at();

-- ---------------------------------------------------------------------------
-- Integration settings (payment gateway + bank feed flags; secrets stay in env)
-- ---------------------------------------------------------------------------
create table if not exists public.finance_integration_settings (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null unique default '00000000-0000-4000-8000-000000000020',
  gsp_mode text not null default 'sandbox' check (gsp_mode in ('sandbox', 'live')),
  payment_gateway_enabled boolean not null default false,
  payment_gateway_provider text not null default 'none'
    check (payment_gateway_provider in ('none', 'razorpay', 'stripe')),
  bank_feed_enabled boolean not null default false,
  bank_feed_provider text not null default 'none'
    check (bank_feed_provider in ('none', 'account_aggregator', 'manual_api')),
  notes text not null default '',
  updated_by uuid references public.employees (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

drop trigger if exists finance_integration_settings_set_updated_at on public.finance_integration_settings;
create trigger finance_integration_settings_set_updated_at
  before update on public.finance_integration_settings
  for each row execute procedure public.set_updated_at();

insert into public.finance_integration_settings (organization_id, gsp_mode)
values ('00000000-0000-4000-8000-000000000020', 'sandbox')
on conflict (organization_id) do nothing;

-- Optional customer payment checkout intents (gateway-ready; no charge without keys)
create table if not exists public.finance_payment_checkout_intents (
  id uuid primary key default gen_random_uuid(),
  invoice_id uuid not null references public.finance_invoices (id) on delete restrict,
  customer_id uuid not null references public.finance_customers (id) on delete restrict,
  amount numeric(14, 2) not null check (amount > 0),
  currency_code text not null default 'INR',
  provider text not null default 'none',
  status text not null default 'created'
    check (status in ('created', 'pending', 'paid', 'failed', 'cancelled')),
  provider_reference text not null default '',
  checkout_url text not null default '',
  error_message text not null default '',
  created_by uuid references public.employees (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

drop trigger if exists finance_payment_checkout_intents_set_updated_at on public.finance_payment_checkout_intents;
create trigger finance_payment_checkout_intents_set_updated_at
  before update on public.finance_payment_checkout_intents
  for each row execute procedure public.set_updated_at();

-- ---------------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------------
alter table public.finance_einvoices enable row level security;
alter table public.finance_eway_bills enable row level security;
alter table public.finance_gstn_sync_jobs enable row level security;
alter table public.finance_integration_settings enable row level security;
alter table public.finance_payment_checkout_intents enable row level security;

do $$
declare
  t text;
begin
  foreach t in array array[
    'finance_einvoices',
    'finance_eway_bills',
    'finance_gstn_sync_jobs',
    'finance_integration_settings',
    'finance_payment_checkout_intents'
  ]
  loop
    execute format('drop policy if exists %I_all on public.%I', t, t);
    execute format(
      'create policy %I_all on public.%I for all to authenticated using (
        public.authorize(''finance.integrations.view'')
        or public.authorize(''finance.integrations.manage'')
        or public.authorize(''finance.gst.view'')
        or public.authorize(''finance.gst.manage'')
      ) with check (
        public.authorize(''finance.integrations.manage'')
        or public.authorize(''finance.gst.manage'')
      )',
      t, t
    );
  end loop;
end $$;

notify pgrst, 'reload schema';
