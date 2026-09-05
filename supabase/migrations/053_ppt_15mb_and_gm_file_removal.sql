"-- Raise weekly + JC PPT limits 5 MB → 15 MB.
-- Allow GM to remove weekly PPT files from storage while keeping audit rows.
-- Add JC status/event: deleted (GM removes without download/email).

-- 15 MB = 15728640 bytes
update storage.buckets
set file_size_limit = 15728640
where id in ('weekly-work-updates', 'jc-ppt-uploads');

alter table public.weekly_work_updates
  drop constraint if exists weekly_work_updates_size_bytes_check;

alter table public.weekly_work_updates
  add constraint weekly_work_updates_size_bytes_check
  check (size_bytes > 0 and size_bytes <= 15728640);

alter table public.weekly_work_updates
  alter column storage_path drop not null;

alter table public.weekly_work_updates
  add column if not exists file_removed_at timestamptz,
  add column if not exists file_removed_by uuid references public.employees (id) on delete set null,
  add column if not exists file_removed_reason text
    check (file_removed_reason is null or file_removed_reason in ('downloaded', 'emailed', 'deleted')),
  add column if not exists email_recipient text;

comment on table public.weekly_work_updates is
  'Employee weekly wrap PPT (Mon–Sun week). Max 2 uploads/week; 2nd replaces 1st. late = after Sun 18:00 IST. Max 15 MB. GM may remove storage file; row kept for audit.';

alter table public.jc_ppts
  drop constraint if exists jc_ppts_size_bytes_check;

alter table public.jc_ppts
  add constraint jc_ppts_size_bytes_check
  check (size_bytes > 0 and size_bytes <= 15728640);

alter table public.jc_ppts
  drop constraint if exists jc_ppts_status_check;

alter table public.jc_ppts
  add constraint jc_ppts_status_check
  check (status in ('uploaded', 'with_gm', 'downloaded', 'emailed', 'deleted'));

alter table public.jc_ppt_events
  drop constraint if exists jc_ppt_events_event_type_check;

alter table public.jc_ppt_events
  add constraint jc_ppt_events_event_type_check
  check (event_type in ('uploaded', 'replaced', 'transferred_to_gm', 'downloaded', 'emailed', 'deleted'));

comment on table public.jc_ppts is
  'JC PPT: employee uploads; CSO transfers to GM; GM download/email/delete removes storage file but keeps this audit row. Max 15 MB.';

notify pgrst, 'reload schema';
"