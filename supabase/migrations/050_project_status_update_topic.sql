-- Optional topic on project status updates for clearer lead → CSO notes.

alter table public.project_status_updates
  add column if not exists topic text;

alter table public.project_status_updates
  drop constraint if exists project_status_updates_topic_chk;

alter table public.project_status_updates
  add constraint project_status_updates_topic_chk
  check (
    topic is null
    or topic in ('PROGRESS', 'RISK', 'BLOCKER', 'NEXT_STEPS', 'OTHER')
  );

notify pgrst, 'reload schema';
