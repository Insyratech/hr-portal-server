-- Remove 046 backfill data and all project status updates.
-- After this, leads add goals via "Add goal", set one as primary, then add and activate milestones.

-- PROJECT priorities require milestone_id; clear those links before dropping milestones.
delete from public.weekly_priorities
where priority_type = 'PROJECT' and milestone_id is not null;

delete from public.project_milestone_history;
delete from public.project_milestones;
delete from public.project_goals;

delete from public.project_status_updates;
