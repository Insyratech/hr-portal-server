-- Fresh start: wipe all weekly priorities so employees begin from a clean slate.
-- Safe to run after 046 if priorities were recreated since the goals/milestones rollout.

update public.weekly_priorities
set carried_from_id = null
where carried_from_id is not null;

delete from public.notifications
where reference_type in ('weekly_priority', 'weekly_plan');

delete from public.week_feedback;
delete from public.weekly_priorities;
delete from public.weekly_plans;
