-- Link company officers to a GST registration (letterhead). Additive / nullable for existing rows.

alter table public.finance_org_officers
  add column if not exists org_gst_profile_id uuid
    references public.finance_org_gst_profiles (id) on delete cascade;

create index if not exists finance_org_officers_gst_profile_idx
  on public.finance_org_officers (org_gst_profile_id, role);

notify pgrst, 'reload schema';
