-- One-off (Supabase SQL editor).
-- Amogh Bellurkar shift change 2026-10-30: complete the PROJECT LEAD step only.
-- Status stays PENDING. HR still approves after this.

-- =============================================================================
-- STEP 1 — inspect
-- =============================================================================

select e.id, e.employee_code, e.full_name
from public.employees e
where e.status = 'active'
  and e.full_name ilike '%amogh%'
order by e.full_name;

select
  e.full_name,
  scr.id,
  scr.status,
  scr.start_date,
  scr.end_date,
  req.name as requested_shift,
  cur.name as current_shift,
  scr.project_lead_required,
  scr.project_lead_accepted,
  scr.project_lead_employee_id,
  snap.full_name as snapshot_lead,
  live.full_name as current_project_lead,
  p.name as project_name,
  scr.reason
from public.shift_change_requests scr
join public.employees e on e.id = scr.employee_id
left join public.shifts req on req.id = scr.requested_shift_id
left join public.shifts cur on cur.id = scr.current_shift_id
left join public.projects p on p.id = scr.project_id
left join public.employees snap on snap.id = scr.project_lead_employee_id
left join public.employees live on live.id = p.lead_employee_id
where e.status = 'active'
  and e.full_name ilike '%amogh%'
  and scr.status = 'PENDING'
order by scr.created_at desc;

-- =============================================================================
-- STEP 2 — project-lead accept (HR still decides after this)
-- =============================================================================

begin;

update public.shift_change_requests scr
set
  project_lead_accepted = true,
  project_lead_acted_at = now(),
  project_lead_employee_id = coalesce(
    scr.project_lead_employee_id,
    (
      select p.lead_employee_id
      from public.projects p
      where p.id = scr.project_id
    )
  )
from public.employees e
where scr.employee_id = e.id
  and e.status = 'active'
  and e.full_name ilike '%amogh%'
  and scr.status = 'PENDING'
  and scr.project_lead_required = true
  and scr.project_lead_accepted = false
  and scr.start_date = date '2026-10-30';

commit;

-- =============================================================================
-- STEP 3 — confirm: should show accepted=true, status still PENDING
-- =============================================================================

select
  e.full_name,
  scr.id,
  scr.status,
  scr.start_date,
  scr.project_lead_required,
  scr.project_lead_accepted,
  scr.project_lead_acted_at,
  lead.full_name as project_lead
from public.shift_change_requests scr
join public.employees e on e.id = scr.employee_id
left join public.employees lead on lead.id = scr.project_lead_employee_id
where e.full_name ilike '%amogh%'
  and scr.start_date = date '2026-10-30';
