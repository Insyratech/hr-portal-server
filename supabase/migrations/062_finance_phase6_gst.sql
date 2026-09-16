-- Finance Phase 6: GST registers (outward/inward/ITC/HSN) + basic TDS on bills.
-- Additive; depends on 056–061. No GSTN API — capture + export workbooks only.

insert into public.permissions (code, description) values
  ('finance.gst.view', 'View GST registers, HSN summary, and tax workbooks'),
  ('finance.gst.manage', 'Manage ITC flags and TDS on bills; export GST workbooks')
on conflict (code) do nothing;

insert into public.role_permissions (role_id, permission_id)
select r.id, p.id
from public.roles r
cross join public.permissions p
where r.code = 'FINANCE_MANAGER'
  and p.code in ('finance.gst.view', 'finance.gst.manage')
on conflict do nothing;

-- ---------------------------------------------------------------------------
-- HSN/SAC on document lines (copied from items when available)
-- ---------------------------------------------------------------------------
alter table public.finance_invoice_lines
  add column if not exists hsn_sac text not null default '';

alter table public.finance_vendor_bill_lines
  add column if not exists hsn_sac text not null default '';

alter table public.finance_credit_note_lines
  add column if not exists hsn_sac text not null default '';

-- ---------------------------------------------------------------------------
-- Place of supply snapshot on posted tax documents
-- ---------------------------------------------------------------------------
alter table public.finance_invoices
  add column if not exists place_of_supply_state text,
  add column if not exists is_intra_state boolean;

alter table public.finance_vendor_bills
  add column if not exists place_of_supply_state text,
  add column if not exists is_intra_state boolean,
  add column if not exists tds_section text not null default '',
  add column if not exists tds_percent numeric(8, 4) not null default 0,
  add column if not exists tds_amount numeric(14, 2) not null default 0,
  add column if not exists itc_eligibility text not null default 'eligible';

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'finance_vendor_bills_itc_eligibility_check'
  ) then
    alter table public.finance_vendor_bills
      add constraint finance_vendor_bills_itc_eligibility_check
      check (itc_eligibility in ('eligible', 'ineligible', 'claimed', 'reversed'));
  end if;
end $$;

alter table public.finance_credit_notes
  add column if not exists place_of_supply_state text,
  add column if not exists is_intra_state boolean;

-- Backfill HSN from items where line has item_id
update public.finance_invoice_lines l
set hsn_sac = coalesce(nullif(i.hsn_sac, ''), l.hsn_sac)
from public.finance_items i
where l.item_id = i.id and coalesce(l.hsn_sac, '') = '';

update public.finance_vendor_bill_lines l
set hsn_sac = coalesce(nullif(i.hsn_sac, ''), l.hsn_sac)
from public.finance_items i
where l.item_id = i.id and coalesce(l.hsn_sac, '') = '';

notify pgrst, 'reload schema';
