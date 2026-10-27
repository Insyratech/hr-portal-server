-- JC PPTs go directly to General Manager on upload (same as weekly PPT).
-- CSO keeps tracking/history only — no transfer step.
-- Move any files still sitting in the old "uploaded / pending CSO" state into the GM inbox.

update public.jc_ppts
set
  status = 'with_gm',
  transferred_at = coalesce(transferred_at, uploaded_at, now())
where status = 'uploaded';

insert into public.jc_ppt_events (jc_ppt_id, actor_id, event_type, note)
select
  j.id,
  null,
  'transferred_to_gm',
  'Sent directly to General Manager (CSO transfer step removed).'
from public.jc_ppts j
where j.status = 'with_gm'
  and not exists (
    select 1
    from public.jc_ppt_events e
    where e.jc_ppt_id = j.id
      and e.event_type = 'transferred_to_gm'
  );

notify pgrst, 'reload schema';
