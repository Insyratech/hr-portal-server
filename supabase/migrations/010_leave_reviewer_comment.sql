alter table public.leave_applications
  add column if not exists reviewer_comment text;

notify pgrst, 'reload schema';
