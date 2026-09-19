-- Vendor registration enrichment + multi-GST org profiles (additive, production-safe).

-- ---------------------------------------------------------------------------
-- Our company: multiple GST profiles (letterhead for vendor form / docs)
-- ---------------------------------------------------------------------------
create table if not exists public.finance_org_gst_profiles (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.finance_organizations (id) on delete cascade,
  label text not null default '',
  gstin text not null,
  legal_name text not null default '',
  trade_name text not null default '',
  cin text,
  pan text,
  state_code text,
  state_name text,
  address_line1 text not null default '',
  address_line2 text not null default '',
  city text not null default '',
  postal_code text not null default '',
  logo_storage_path text,
  registration_type text
    check (registration_type is null or registration_type in ('regular', 'composition', 'unregistered')),
  is_default boolean not null default false,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists finance_org_gst_profiles_gstin_uidx
  on public.finance_org_gst_profiles (organization_id, gstin);

create index if not exists finance_org_gst_profiles_org_idx
  on public.finance_org_gst_profiles (organization_id, active);

drop trigger if exists finance_org_gst_profiles_set_updated_at on public.finance_org_gst_profiles;
create trigger finance_org_gst_profiles_set_updated_at
  before update on public.finance_org_gst_profiles
  for each row execute procedure public.set_updated_at();

-- ---------------------------------------------------------------------------
-- Our company: reusable addresses (billing / shipping / registered / operating)
-- ---------------------------------------------------------------------------
create table if not exists public.finance_org_addresses (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.finance_organizations (id) on delete cascade,
  label text not null default '',
  address_type text not null default 'other'
    check (address_type in ('registered', 'operating', 'billing', 'shipping', 'factory', 'other')),
  line1 text not null default '',
  line2 text not null default '',
  city text not null default '',
  state_code text,
  state_name text,
  postal_code text not null default '',
  country_code text not null default 'IN',
  is_default boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists finance_org_addresses_org_idx
  on public.finance_org_addresses (organization_id, address_type);

drop trigger if exists finance_org_addresses_set_updated_at on public.finance_org_addresses;
create trigger finance_org_addresses_set_updated_at
  before update on public.finance_org_addresses
  for each row execute procedure public.set_updated_at();

-- ---------------------------------------------------------------------------
-- Our company: CEO / directors
-- ---------------------------------------------------------------------------
create table if not exists public.finance_org_officers (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.finance_organizations (id) on delete cascade,
  role text not null check (role in ('ceo', 'director', 'other')),
  full_name text not null,
  designation text not null default '',
  email text,
  phone text,
  din text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists finance_org_officers_org_idx
  on public.finance_org_officers (organization_id, role);

drop trigger if exists finance_org_officers_set_updated_at on public.finance_org_officers;
create trigger finance_org_officers_set_updated_at
  before update on public.finance_org_officers
  for each row execute procedure public.set_updated_at();

-- ---------------------------------------------------------------------------
-- Vendor master enrichment (nullable / defaulted — existing rows stay valid)
-- ---------------------------------------------------------------------------
alter table public.finance_vendors
  add column if not exists telephone text,
  add column if not exists fax text,
  add column if not exists registered_address text not null default '',
  add column if not exists factory_address text not null default '',
  add column if not exists shipping_address text not null default '',
  add column if not exists establishment_type text not null default '',
  add column if not exists constitution text not null default '',
  add column if not exists year_established text not null default '',
  add column if not exists sales_tax_reg_no text,
  add column if not exists factory_license_no text,
  add column if not exists business_profile text not null default '',
  add column if not exists bank_name_address text not null default '',
  add column if not exists bank_account_no text,
  add column if not exists ifsc text,
  add column if not exists micr text,
  add column if not exists credit_limit numeric(14, 2),
  add column if not exists contact_person_name text not null default '',
  add column if not exists contact_person_designation text not null default '',
  add column if not exists contact_person_mobile text,
  add column if not exists declaration_name text not null default '',
  add column if not exists declaration_designation text not null default '',
  add column if not exists declaration_place text not null default '',
  add column if not exists declaration_date date,
  add column if not exists vendor_signature_path text,
  add column if not exists org_gst_profile_id uuid references public.finance_org_gst_profiles (id) on delete set null,
  add column if not exists billing_address_id uuid references public.finance_org_addresses (id) on delete set null,
  add column if not exists shipping_address_id uuid references public.finance_org_addresses (id) on delete set null,
  add column if not exists office_inspected_by text not null default '',
  add column if not exists office_inspection_date date,
  add column if not exists vendor_code text,
  add column if not exists office_approved_by text not null default '',
  add column if not exists office_decision text
    check (office_decision is null or office_decision in ('approved', 'rejected', 'pending'));

-- Backfill registered_address from billing_address where empty
update public.finance_vendors
set registered_address = billing_address
where coalesce(registered_address, '') = '' and coalesce(billing_address, '') <> '';

-- ---------------------------------------------------------------------------
-- Vendor principal customers (commercial table on form page 2)
-- ---------------------------------------------------------------------------
create table if not exists public.finance_vendor_principal_customers (
  id uuid primary key default gen_random_uuid(),
  vendor_id uuid not null references public.finance_vendors (id) on delete cascade,
  customer_name_address text not null default '',
  product_supplied text not null default '',
  sort_order integer not null default 0,
  created_at timestamptz not null default now()
);

create index if not exists finance_vendor_principal_customers_vendor_idx
  on public.finance_vendor_principal_customers (vendor_id, sort_order);

-- ---------------------------------------------------------------------------
-- Vendor document checklist uploads
-- ---------------------------------------------------------------------------
create table if not exists public.finance_vendor_documents (
  id uuid primary key default gen_random_uuid(),
  vendor_id uuid not null references public.finance_vendors (id) on delete cascade,
  document_type text not null check (document_type in (
    'income_tax',
    'sales_tax_license',
    'msme_ssi_license',
    'gst_certificate',
    'pan_card',
    'cancelled_cheque',
    'iso_certificate',
    'other'
  )),
  file_name text not null,
  storage_path text not null,
  content_type text not null default 'application/pdf',
  size_bytes bigint not null default 0,
  created_at timestamptz not null default now(),
  unique (vendor_id, document_type)
);

create index if not exists finance_vendor_documents_vendor_idx
  on public.finance_vendor_documents (vendor_id);

-- ---------------------------------------------------------------------------
-- Storage buckets
-- ---------------------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values
  (
    'finance-org-logos',
    'finance-org-logos',
    false,
    2097152,
    array['image/jpeg', 'image/png', 'image/webp']
  ),
  (
    'finance-vendor-docs',
    'finance-vendor-docs',
    false,
    10485760,
    array['application/pdf', 'image/jpeg', 'image/png', 'image/webp']
  )
on conflict (id) do nothing;

drop policy if exists finance_org_logos_select on storage.objects;
create policy finance_org_logos_select on storage.objects
  for select to authenticated
  using (bucket_id = 'finance-org-logos' and public.authorize('finance.org.manage'));

drop policy if exists finance_org_logos_insert on storage.objects;
create policy finance_org_logos_insert on storage.objects
  for insert to authenticated
  with check (bucket_id = 'finance-org-logos' and public.authorize('finance.org.manage'));

drop policy if exists finance_vendor_docs_select on storage.objects;
create policy finance_vendor_docs_select on storage.objects
  for select to authenticated
  using (bucket_id = 'finance-vendor-docs' and public.authorize('finance.parties.manage'));

drop policy if exists finance_vendor_docs_insert on storage.objects;
create policy finance_vendor_docs_insert on storage.objects
  for insert to authenticated
  with check (bucket_id = 'finance-vendor-docs' and public.authorize('finance.parties.manage'));

-- ---------------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------------
alter table public.finance_org_gst_profiles enable row level security;
alter table public.finance_org_addresses enable row level security;
alter table public.finance_org_officers enable row level security;
alter table public.finance_vendor_principal_customers enable row level security;
alter table public.finance_vendor_documents enable row level security;

drop policy if exists finance_org_gst_profiles_all on public.finance_org_gst_profiles;
create policy finance_org_gst_profiles_all on public.finance_org_gst_profiles
  for all to authenticated
  using (public.authorize('finance.org.manage') or public.authorize('finance.parties.manage'))
  with check (public.authorize('finance.org.manage'));

drop policy if exists finance_org_addresses_all on public.finance_org_addresses;
create policy finance_org_addresses_all on public.finance_org_addresses
  for all to authenticated
  using (public.authorize('finance.org.manage') or public.authorize('finance.parties.manage'))
  with check (public.authorize('finance.org.manage') or public.authorize('finance.parties.manage'));

drop policy if exists finance_org_officers_all on public.finance_org_officers;
create policy finance_org_officers_all on public.finance_org_officers
  for all to authenticated
  using (public.authorize('finance.org.manage'))
  with check (public.authorize('finance.org.manage'));

drop policy if exists finance_vendor_principal_customers_all on public.finance_vendor_principal_customers;
create policy finance_vendor_principal_customers_all on public.finance_vendor_principal_customers
  for all to authenticated
  using (public.authorize('finance.parties.manage'))
  with check (public.authorize('finance.parties.manage'));

drop policy if exists finance_vendor_documents_all on public.finance_vendor_documents;
create policy finance_vendor_documents_all on public.finance_vendor_documents
  for all to authenticated
  using (public.authorize('finance.parties.manage'))
  with check (public.authorize('finance.parties.manage'));

grant all on public.finance_org_gst_profiles, public.finance_org_addresses, public.finance_org_officers,
  public.finance_vendor_principal_customers, public.finance_vendor_documents
  to service_role;

-- Seed default GST profile from singleton org when GSTIN exists
insert into public.finance_org_gst_profiles (
  organization_id, label, gstin, legal_name, trade_name, cin, pan,
  state_code, state_name, address_line1, address_line2, city, postal_code,
  registration_type, is_default, active
)
select
  o.id,
  coalesce(nullif(o.trade_name, ''), 'Primary GST'),
  o.gstin,
  o.legal_name,
  o.trade_name,
  o.cin,
  o.pan,
  o.state_code,
  o.state_name,
  o.address_line1,
  o.address_line2,
  o.city,
  o.postal_code,
  o.gst_registration_type,
  true,
  true
from public.finance_organizations o
where o.gstin is not null and length(trim(o.gstin)) > 0
on conflict (organization_id, gstin) do nothing;

-- Seed registered address from org profile when present
insert into public.finance_org_addresses (
  organization_id, label, address_type, line1, line2, city, state_code, state_name, postal_code, is_default
)
select
  o.id,
  'Registered office',
  'registered',
  o.address_line1,
  o.address_line2,
  o.city,
  o.state_code,
  o.state_name,
  o.postal_code,
  true
from public.finance_organizations o
where coalesce(o.address_line1, '') <> ''
  and not exists (
    select 1 from public.finance_org_addresses a
    where a.organization_id = o.id and a.address_type = 'registered'
  );

notify pgrst, 'reload schema';
