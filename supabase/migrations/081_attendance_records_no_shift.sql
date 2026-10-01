-- Allow NO_SHIFT on published attendance (import reviews already use it when no assignment).

alter table public.attendance_records
  drop constraint if exists attendance_records_status_check;

alter table public.attendance_records
  add constraint attendance_records_status_check
  check (
    status in (
      'PRESENT',
      'ABSENT',
      'LATE',
      'HALF_DAY',
      'LEAVE',
      'HOLIDAY',
      'WEEK_OFF',
      'MISSING_PUNCH',
      'NO_SHIFT'
    )
  );

notify pgrst, 'reload schema';
