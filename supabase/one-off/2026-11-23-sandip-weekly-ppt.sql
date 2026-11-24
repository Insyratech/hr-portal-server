-- One-off (Supabase SQL editor).
-- Sandip Kumar Yadav (ID2025009): file the weekly PPT after the upload window closed.
--
-- Portal week is Tuesday–Monday. The window that closed is:
--   week_start 2026-11-17
--   week_end   2026-11-23
--   upload was open Sat 21 Nov 14:00 IST through Sun 22 Nov 23:59 IST.
-- The local file is named Sandip-Nov-16-21.pptx. It is stored against 17–23 Nov.
--
-- SQL cannot read the Mac file. Upload the bytes first, then run STEP 2.
--
-- Storage (dashboard → Storage → weekly-work-updates → Upload):
--   Local file:  /Users/sandip/Downloads/Sandip-Nov-16-21.pptx
--   Bucket:      weekly-work-updates
--   Object name: 3a882b24-30d7-4c47-961e-513b73b1aba7/2026-11-17/a7c3e1d4-6b28-4f5a-9c0e-1d2b3a4f5e60-Sandip_Kumar_Yadav_November_17-23.pptx
--   Size:        53143 bytes. If you re-save the PPT, put the new size in STEP 2.
--
-- What STEP 2 does:
--   • inserts or replaces weekly_work_updates for that week
--   • marks it late (the window is already closed)
--   • attaches it to the week's GM package (note = direct_to_gm)
--   • does not send mail
--
-- Run STEP 1 first. Confirm one Sandip and that the storage object exists.
-- Then run STEP 2.

-- =============================================================================
-- STEP 1 — inspect
-- =============================================================================

select e.id, e.employee_code, e.full_name, e.status
from public.employees e
where e.deleted_at is null
  and (
    e.id = '3a882b24-30d7-4c47-961e-513b73b1aba7'
    or e.employee_code = 'ID2025009'
    or e.full_name ilike 'Sandip Kumar Yadav'
  );

select
  w.id,
  w.week_start,
  w.week_end,
  w.original_file_name,
  w.system_file_name,
  w.storage_path,
  w.size_bytes,
  w.upload_count,
  w.late,
  w.submission_timing,
  w.submitted_at
from public.weekly_work_updates w
where w.employee_id = '3a882b24-30d7-4c47-961e-513b73b1aba7'
  and w.week_start = date '2026-11-17';

select name, (metadata ->> 'size') as size_bytes, created_at
from storage.objects
where bucket_id = 'weekly-work-updates'
  and name = '3a882b24-30d7-4c47-961e-513b73b1aba7/2026-11-17/a7c3e1d4-6b28-4f5a-9c0e-1d2b3a4f5e60-Sandip_Kumar_Yadav_November_17-23.pptx';

-- =============================================================================
-- STEP 2 — apply (only after STEP 1 shows the storage object)
-- =============================================================================

begin;

do $$
declare
  v_emp_id uuid := '3a882b24-30d7-4c47-961e-513b73b1aba7';
  v_week_start date := date '2026-11-17';
  v_week_end date := date '2026-11-23';
  v_path text := '3a882b24-30d7-4c47-961e-513b73b1aba7/2026-11-17/a7c3e1d4-6b28-4f5a-9c0e-1d2b3a4f5e60-Sandip_Kumar_Yadav_November_17-23.pptx';
  v_size integer := 53143;
  v_update_id uuid;
  v_share_id uuid;
  v_count integer;
  v_upload_count integer;
begin
  if not exists (
    select 1
    from public.employees e
    where e.id = v_emp_id
      and e.deleted_at is null
      and e.employee_code = 'ID2025009'
      and e.full_name ilike 'Sandip Kumar Yadav'
  ) then
    raise exception 'Employee is not Sandip Kumar Yadav (ID2025009). Nothing was changed.';
  end if;

  if not exists (
    select 1
    from storage.objects o
    where o.bucket_id = 'weekly-work-updates'
      and o.name = v_path
  ) then
    raise exception 'Upload the PPT to storage object % before running this step.', v_path;
  end if;

  select w.id, w.upload_count
  into v_update_id, v_upload_count
  from public.weekly_work_updates w
  where w.employee_id = v_emp_id
    and w.week_start = v_week_start;

  if v_update_id is null then
    insert into public.weekly_work_updates (
      employee_id,
      week_start,
      week_end,
      storage_path,
      original_file_name,
      system_file_name,
      content_type,
      size_bytes,
      upload_count,
      submitted_at,
      late,
      submission_timing,
      file_removed_at,
      file_removed_by,
      file_removed_reason,
      email_recipient
    )
    values (
      v_emp_id,
      v_week_start,
      v_week_end,
      v_path,
      'Sandip-Nov-16-21.pptx',
      'Sandip_Kumar_Yadav_November_17-23.pptx',
      'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      v_size,
      1,
      now(),
      true,
      'late',
      null,
      null,
      null,
      null
    )
    returning id into v_update_id;
  else
    update public.weekly_work_updates
    set
      week_end = v_week_end,
      storage_path = v_path,
      original_file_name = 'Sandip-Nov-16-21.pptx',
      system_file_name = 'Sandip_Kumar_Yadav_November_17-23.pptx',
      content_type = 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      size_bytes = v_size,
      upload_count = least(v_upload_count + 1, 10),
      submitted_at = now(),
      late = true,
      submission_timing = 'late',
      file_removed_at = null,
      file_removed_by = null,
      file_removed_reason = null,
      email_recipient = null
    where id = v_update_id;
  end if;

  select s.id into v_share_id
  from public.weekly_ppt_shares s
  where s.week_start = v_week_start
    and s.note = 'direct_to_gm'
  order by s.shared_at desc
  limit 1;

  if v_share_id is null then
    insert into public.weekly_ppt_shares (
      week_start, week_end, shared_by, file_count, note
    )
    values (v_week_start, v_week_end, v_emp_id, 0, 'direct_to_gm')
    returning id into v_share_id;
  end if;

  insert into public.weekly_ppt_share_items (share_id, update_id)
  values (v_share_id, v_update_id)
  on conflict (share_id, update_id) do nothing;

  select count(*) into v_count
  from public.weekly_ppt_share_items
  where share_id = v_share_id;

  update public.weekly_ppt_shares
  set file_count = v_count, shared_at = now()
  where id = v_share_id;

  raise notice 'Weekly PPT % filed for Sandip, week % to %. Share %.',
    v_update_id, v_week_start, v_week_end, v_share_id;
end;
$$;

commit;

-- =============================================================================
-- STEP 3 — verify
-- =============================================================================

select
  w.week_start,
  w.week_end,
  w.original_file_name,
  w.system_file_name,
  w.storage_path,
  w.size_bytes,
  w.late,
  w.submission_timing,
  w.submitted_at
from public.weekly_work_updates w
where w.employee_id = '3a882b24-30d7-4c47-961e-513b73b1aba7'
  and w.week_start = date '2026-11-17';
