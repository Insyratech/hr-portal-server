-- Ensure only one Current working week per employee (effective_to is null).
-- Close any duplicate open rows, keeping the latest effective_from.

with ranked as (
  select
    id,
    employee_id,
    effective_from,
    row_number() over (
      partition by employee_id
      order by effective_from desc, created_at desc
    ) as rn
  from public.employee_work_weeks
  where effective_to is null
),
to_close as (
  select
    r.id,
    greatest(
      r.effective_from,
      (r2.effective_from - interval '1 day')::date
    ) as close_on
  from ranked r
  join ranked r2 on r2.employee_id = r.employee_id and r2.rn = 1
  where r.rn > 1
)
update public.employee_work_weeks eww
set effective_to = tc.close_on
from to_close tc
where eww.id = tc.id;

create unique index if not exists employee_work_weeks_one_current_per_employee_idx
  on public.employee_work_weeks (employee_id)
  where effective_to is null;
