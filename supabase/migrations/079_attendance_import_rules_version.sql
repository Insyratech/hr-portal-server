-- Stamp which attendance rule set an open import was last calculated with.
-- Lets GET refresh only once after rule changes (permission credit, punch skew, grace).

alter table public.attendance_imports
  add column if not exists rules_version integer not null default 0;

notify pgrst, 'reload schema';
