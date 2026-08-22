-- Optional inbox for HR/update mail (login email stays on employees.email).
alter table public.employees
  add column if not exists notification_email text;
