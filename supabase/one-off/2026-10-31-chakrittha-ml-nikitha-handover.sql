-- One-off. Chakrittha ML 2026-10-15
-- (hr/leaves/8cdddcd4-de99-4314-9dc4-142f38a317a9)
-- Mark HANDOVER accepted by Venkata Sai Nikitha Teku.
-- Leave stays PENDING. Project lead / HR still decide after this.

-- =============================================================================
-- STEP 1 — inspect
-- =============================================================================

select e.id, e.employee_code, e.full_name
from public.employees e
where e.status = 'active'
  and e.full_name ilike '%nikith%'
order by e.full_name;

select
  la.id,
  e.full_name as applicant,
  lt.code,
  la.status,
  la.start_date,
  la.end_date,
  la.handover,
  la.handover_employee_id,
  h.full_name as handover_person,
  lap.approver_role,
  lap.status as step_status,
  lap.actor_id,
  actor.full_name as actor_name,
  lap.decided_at
from public.leave_applications la
join public.employees e on e.id = la.employee_id
join public.leave_types lt on lt.id = la.leave_type_id
left join public.employees h on h.id = la.handover_employee_id
left join public.leave_approvals lap on lap.application_id = la.id
left join public.employees actor on actor.id = lap.actor_id
where la.id = '8cdddcd4-de99-4314-9dc4-142f38a317a9'
order by lap.step_order;

-- =============================================================================
-- STEP 2 — Nikitha accepts handover AND project lead approves
-- Leave application stays PENDING so HR can still Approve in the portal.
-- =============================================================================

begin;

update public.leave_approvals lap
set
  status = 'APPROVED',
  actor_id = (
    select e.id
    from public.employees e
    where e.status = 'active'
      and e.full_name ilike '%nikith%'
    order by e.full_name
    limit 1
  ),
  decided_at = now(),
  comment = coalesce(lap.comment, 'Handover accepted (SQL one-off).')
where lap.application_id = '8cdddcd4-de99-4314-9dc4-142f38a317a9'
  and lap.approver_role = 'HANDOVER'
  and lap.status = 'PENDING';

update public.leave_approvals lap
set
  status = 'APPROVED',
  actor_id = coalesce(
    (
      select p.lead_employee_id
      from public.leave_applications la
      join public.projects p on p.id = la.project_id
      where la.id = lap.application_id
    ),
    (
      select e.id
      from public.employees e
      where e.status = 'active'
        and e.full_name ilike '%benet%'
      limit 1
    )
  ),
  decided_at = now(),
  comment = coalesce(lap.comment, 'Project lead approved (SQL one-off).')
where lap.application_id = '8cdddcd4-de99-4314-9dc4-142f38a317a9'
  and lap.approver_role = 'PROJECT_LEAD'
  and lap.status = 'PENDING';

commit;

-- =============================================================================
-- STEP 3 — confirm: HANDOVER and PROJECT_LEAD should be APPROVED; leave still PENDING
-- =============================================================================

select
  lap.approver_role,
  lap.status,
  actor.full_name as actor_name,
  lap.decided_at
from public.leave_approvals lap
left join public.employees actor on actor.id = lap.actor_id
where lap.application_id = '8cdddcd4-de99-4314-9dc4-142f38a317a9'
order by lap.step_order;
