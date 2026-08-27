-- Phase 8: keep the original biometric Excel on Storage. Apply after 017_phase6_payroll.sql.

alter table public.attendance_imports
  add column if not exists storage_path text;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'attendance-imports',
  'attendance-imports',
  false,
  15728640,
  array['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet']::text[]
)
on conflict (id) do nothing;

drop policy if exists attendance_imports_storage_select on storage.objects;
create policy attendance_imports_storage_select on storage.objects for select to authenticated
  using (
    bucket_id = 'attendance-imports'
    and (
      public.authorize('attendance.manage')
      or public.authorize('attendance.view')
    )
  );

notify pgrst, 'reload schema';
