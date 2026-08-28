-- Close duplicate open shift assignments: keep only the latest effective_from per employee.

with ranked as (
  select
    id,
    employee_id,
    effective_from,
    row_number() over (
      partition by employee_id
      order by effective_from desc, created_at desc
    ) as rn
  from public.shift_assignments
  where effective_to is null
),
to_close as (
  select
    r.id,
    (r2.effective_from - interval '1 day')::date as close_on
  from ranked r
  join ranked r2 on r2.employee_id = r.employee_id and r2.rn = 1
  where r.rn > 1
)
update public.shift_assignments sa
set effective_to = tc.close_on
from to_close tc
where sa.id = tc.id;

notify pgrst, 'reload schema';
