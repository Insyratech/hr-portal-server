-- GST registrations as first-class letterheads (GSTIN is the business key). Additive.

alter table public.finance_org_gst_profiles
  add column if not exists phone text,
  add column if not exists email text,
  add column if not exists website text;

-- Normalize existing GSTINs to uppercase without spaces
update public.finance_org_gst_profiles
set gstin = upper(regexp_replace(gstin, '\s+', '', 'g'))
where gstin is not null and gstin <> upper(regexp_replace(gstin, '\s+', '', 'g'));

-- Prefer display label from legal name when label was empty or equalled gstin
update public.finance_org_gst_profiles
set label = coalesce(nullif(trim(legal_name), ''), gstin)
where coalesce(trim(label), '') = '' or trim(label) = gstin;

notify pgrst, 'reload schema';
