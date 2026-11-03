-- HR freelancer invoices. New tables only.
-- Does not change payroll, attendance, or finance sales invoices.
-- The API uses the service role. RLS stays on with no browser policies.

create sequence if not exists public.hr_invoice_number_seq;

create table if not exists public.hr_invoice_clients (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  address text not null default '',
  created_by uuid references public.employees (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists hr_invoice_clients_name_idx
  on public.hr_invoice_clients (lower(name));

create table if not exists public.hr_invoices (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies (id) on delete restrict,
  client_id uuid not null references public.hr_invoice_clients (id) on delete restrict,
  invoice_number text not null unique,
  issue_date date not null,
  due_date date not null,
  reference text not null default '',
  currency text not null check (currency in ('INR', 'GBP', 'USD', 'EUR')),
  issuer_name text not null,
  issuer_address text not null default '',
  issuer_email text not null default '',
  issuer_logo_path text,
  client_name text not null,
  client_address text not null default '',
  signature_name text not null,
  total numeric(14, 2) not null check (total >= 0),
  created_by uuid references public.employees (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (due_date >= issue_date)
);

create index if not exists hr_invoices_created_at_idx
  on public.hr_invoices (created_at desc);

create table if not exists public.hr_invoice_lines (
  id uuid primary key default gen_random_uuid(),
  invoice_id uuid not null references public.hr_invoices (id) on delete cascade,
  line_order integer not null check (line_order >= 1),
  description text not null,
  detail text not null default '',
  quantity numeric(12, 2) not null check (quantity > 0),
  unit_price numeric(14, 2) not null check (unit_price >= 0),
  unique (invoice_id, line_order)
);

create or replace function public.assign_hr_invoice_number()
returns trigger
language plpgsql
as $$
begin
  if new.invoice_number is null or btrim(new.invoice_number) = '' then
    new.invoice_number := lpad(nextval('public.hr_invoice_number_seq')::text, 6, '0');
  end if;
  return new;
end;
$$;

drop trigger if exists hr_invoices_assign_number on public.hr_invoices;
create trigger hr_invoices_assign_number
  before insert on public.hr_invoices
  for each row execute procedure public.assign_hr_invoice_number();

drop trigger if exists hr_invoice_clients_set_updated_at on public.hr_invoice_clients;
create trigger hr_invoice_clients_set_updated_at
  before update on public.hr_invoice_clients
  for each row execute procedure public.set_updated_at();

drop trigger if exists hr_invoices_set_updated_at on public.hr_invoices;
create trigger hr_invoices_set_updated_at
  before update on public.hr_invoices
  for each row execute procedure public.set_updated_at();

alter table public.hr_invoice_clients enable row level security;
alter table public.hr_invoices enable row level security;
alter table public.hr_invoice_lines enable row level security;
