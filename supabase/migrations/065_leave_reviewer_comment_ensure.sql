-- Ensure leave_applications.reviewer_comment exists in production.
-- Idempotent; 010 may not have been applied on older environments.

alter table public.leave_applications
  add column if not exists reviewer_comment text;

notify pgrst, 'reload schema';
