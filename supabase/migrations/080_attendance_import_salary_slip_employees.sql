-- Who should receive salary slips after attendance confirm.
-- null = legacy imports (all review employees); non-null = only listed ids.

alter table public.attendance_imports
  add column if not exists salary_slip_employee_ids uuid[] null;

notify pgrst, 'reload schema';
