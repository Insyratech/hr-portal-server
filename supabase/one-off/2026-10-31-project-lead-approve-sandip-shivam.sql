-- One-off (run in SQL editor). Does NOT fully approve leave/shift — only the project-lead step.
-- HR still reviews after this. Run STEP 1, confirm the people and pending rows, then STEP 2.

-- =============================================================================
-- STEP 1 — inspect (run this first; do not skip)
-- =============================================================================

-- 1a. People
select e.id, e.employee_code, e.full_name, e.status
from public.employees e
where e.status = 'active'
  and (
    e.full_name ilike '%sandip%'
    or e.full_name ilike '%shivam%'
    or e.full_name ilike '%benet%'
  )
order by e.full_name;

-- 1b. Sandip pending leave + approval steps
select
  e.full_name,
  e.employee_code,
  la.id as leave_id,
  la.status as leave_status,
  la.start_date,
  la.end_date,
  la.project_id,
  p.name as project_name,
  p.code as project_code,
  lead.full_name as current_project_lead,
  lap.approver_role,
  lap.status as step_status,
  lap.actor_id,
  lap.decided_at
from public.employees e
join public.leave_applications la on la.employee_id = e.id
left join public.projects p on p.id = la.project_id
left join public.employees lead on lead.id = p.lead_employee_id
left join public.leave_approvals lap on lap.application_id = la.id
where e.status = 'active'
  and e.full_name ilike '%sandip%'
  and la.status = 'PENDING'
order by la.created_at desc, lap.step_order;

-- 1c. Shivam pending shift changes
select
  e.full_name,
  e.employee_code,
  scr.id as shift_change_id,
  scr.status,
  scr.start_date,
  scr.end_date,
  scr.project_id,
  p.name as project_name,
  scr.project_lead_required,
  scr.project_lead_accepted,
  scr.project_lead_employee_id,
  lead.full_name as snapshot_lead,
  live.full_name as current_project_lead
from public.employees e
join public.shift_change_requests scr on scr.employee_id = e.id
left join public.projects p on p.id = scr.project_id
left join public.employees lead on lead.id = scr.project_lead_employee_id
left join public.employees live on live.id = p.lead_employee_id
where e.status = 'active'
  and e.full_name ilike '%shivam%'
  and scr.status = 'PENDING'
order by scr.created_at desc;

-- =============================================================================
-- STEP 2 — project-lead approve (only after STEP 1 looks right)
-- Does not set leave/shift status to APPROVED. HR still decides.
-- Skips leave if handover is still PENDING.
-- =============================================================================

-- 2a. Sandip leave: approve pending PROJECT_LEAD steps
with sandip as (
  select id
  from public.employees
  where status = 'active'
    and full_name ilike '%sandip%'
),
benet as (
  select id
  from public.employees
  where status = 'active'
    and full_name ilike '%benet%'
  limit 1
),
target as (
  select la.id
  from public.leave_applications la
  join sandip s on s.id = la.employee_id
  where la.status = 'PENDING'
    and not exists (
      select 1
      from public.leave_approvals h
      where h.application_id = la.id
        and h.approver_role = 'HANDOVER'
        and h.status = 'PENDING'
    )
    and exists (
      select 1
      from public.leave_approvals p
      where p.application_id = la.id
        and p.approver_role = 'PROJECT_LEAD'
        and p.status = 'PENDING'
    )
)
update public.leave_approvals lap
set
  status = 'APPROVED',
  actor_id = (select id from benet),
  decided_at = now(),
  comment = coalesce(lap.comment, 'Project lead approved (SQL one-off).')
from target
where lap.application_id = target.id
  and lap.approver_role = 'PROJECT_LEAD'
  and lap.status = 'PENDING';

-- 2b. Shivam shift change: mark project-lead accepted
with shivam as (
  select id
  from public.employees
  where status = 'active'
    and full_name ilike '%shivam%'
),
benet as (
  select id
  from public.employees
  where status = 'active'
    and full_name ilike '%benet%'
  limit 1
)
update public.shift_change_requests scr
set
  project_lead_accepted = true,
  project_lead_acted_at = now(),
  project_lead_employee_id = coalesce(scr.project_lead_employee_id, (select id from benet))
from shivam
where scr.employee_id = shivam.id
  and scr.status = 'PENDING'
  and scr.project_lead_required = true
  and scr.project_lead_accepted = false;

-- =============================================================================
-- STEP 3 — confirm
-- =============================================================================

select 'sandip_leave_pl' as kind, lap.application_id as id, lap.status, lap.decided_at
from public.leave_approvals lap
join public.leave_applications la on la.id = lap.application_id
join public.employees e on e.id = la.employee_id
where e.full_name ilike '%sandip%'
  and lap.approver_role = 'PROJECT_LEAD'
  and la.status = 'PENDING'
union all
select 'shivam_shift_pl', scr.id::text, scr.status, scr.project_lead_acted_at
from public.shift_change_requests scr
join public.employees e on e.id = scr.employee_id
where e.full_name ilike '%shivam%'
  and scr.status = 'PENDING';
