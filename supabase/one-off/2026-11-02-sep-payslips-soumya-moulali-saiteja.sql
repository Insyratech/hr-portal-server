-- =============================================================================
-- One-off: September 2026 salary slips for 3 mid-month joiners
-- =============================================================================
-- They were on the confirmed Sep attendance month (GM: MONTH CONFIRMED) but were
-- not included when payroll was calculated/published, so they have no portal slip.
--
-- Soumya Kanta Hati     20260032  joined 2026-09-15  present 15–30 Sep  payable 14
-- Dudekula Hazi Moulali 20260031  joined 2026-09-09  present 09–30 Sep  payable 18
-- Sai Teja Prathikantam 20260033  joined 2026-09-21  present 21–30 Sep  payable  9
--
-- Working days = published attendance_day_reviews, same rule as payroll:
--   count days whose status is not WEEK_OFF / HOLIDAY / NO_SHIFT
--   (NO_SHIFT is how days before joining were stored)
-- LOP = sum(final_lop). Screenshots show 0 LOP for all three.
-- Money = payroll calculateSlipMoney:
--   gross     = monthly CTC (basic+da+hra+fuel+incentives+other)
--   dailyRate = round(gross / 30, 2)
--   payable   = round(dailyRate × working_days, 2)   -- mid-month, not full month
--   lopAmount = round(dailyRate × lop_days, 2)
--   net       = payable − PT − TDS − welfare − KPI − other − LOP
-- Compensation / PAN / bank are snapshotted from employee_compensation and
-- employee_payment (latest row effective on or before 2026-09-30).
-- Slips are inserted onto the existing PUBLISHED 2026-09 payroll run so they
-- appear under /payslips for the employee and under HR/GM published slips.
--
-- Run in Supabase SQL Editor (postgres / service_role).
-- Do STEP 1 → review → STEP 2 → STEP 3.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- STEP 1 — inspect (safe, no writes)
-- ---------------------------------------------------------------------------

-- 1a. Employees + join dates
select
  e.id,
  e.employee_code,
  e.full_name,
  e.joining_date,
  e.status,
  e.user_id is not null as has_portal_login,
  c.name as company_name,
  d.name as designation_name,
  dep.name as department_name
from public.employees e
left join public.companies c on c.id = e.company_id
left join public.designations d on d.id = e.designation_id
left join public.departments dep on dep.id = e.department_id
where e.employee_code in ('20260031', '20260032', '20260033')
order by e.employee_code;

-- 1b. Confirmed Sep import + published payroll run
select
  i.id as import_id,
  i.period,
  i.status as import_status,
  i.confirmed_at,
  cardinality(i.salary_slip_employee_ids) as selected_for_slips,
  (
    select count(*)::int
    from public.employees e
    where e.employee_code in ('20260031', '20260032', '20260033')
      and i.salary_slip_employee_ids is not null
      and e.id = any (i.salary_slip_employee_ids)
  ) as these_three_selected
from public.attendance_imports i
where i.period = '2026-09'
  and i.status = 'CONFIRMED'
order by i.confirmed_at desc nulls last, i.created_at desc;

select
  r.id as run_id,
  r.period,
  r.status as payroll_status,
  r.attendance_import_id,
  r.published_at,
  (select count(*)::int from public.salary_slips s where s.run_id = r.id) as existing_slip_count
from public.payroll_runs r
where r.period = '2026-09';

-- 1c. These three must NOT already have a 2026-09 slip
select
  e.employee_code,
  e.full_name,
  s.id as existing_slip_id,
  r.status as run_status,
  s.net
from public.employees e
left join public.salary_slips s on s.employee_id = e.id
left join public.payroll_runs r on r.id = s.run_id and r.period = '2026-09'
where e.employee_code in ('20260031', '20260032', '20260033')
order by e.employee_code;

-- 1d. Compensation (row used for the slip) + payment
select
  e.employee_code,
  e.full_name,
  c.effective_from,
  c.basic,
  c.da,
  c.hra,
  c.fuel,
  c.incentives,
  c.other_earnings,
  (c.basic + c.da + c.hra + c.fuel + c.incentives + c.other_earnings) as monthly_gross,
  c.professional_tax,
  c.tds,
  c.employee_welfare,
  c.kpi,
  c.other_deductions,
  p.pan,
  p.bank_name,
  p.ifsc,
  p.bank_account_number
from public.employees e
left join lateral (
  select c.*
  from public.employee_compensation c
  where c.employee_id = e.id
    and c.effective_from <= date '2026-09-30'
  order by c.effective_from desc
  limit 1
) c on true
left join public.employee_payment p on p.employee_id = e.id
where e.employee_code in ('20260031', '20260032', '20260033')
order by e.employee_code;

-- 1e. Attendance working days vs expected payable (from GM cards)
--     expected: Moulali 18, Soumya 14, Sai Teja 9. LOP 0.
select
  e.employee_code,
  e.full_name,
  e.joining_date,
  t.expected_working_days,
  count(*)::int as review_days,
  count(*) filter (
    where d.status not in ('WEEK_OFF', 'HOLIDAY', 'NO_SHIFT')
  )::int as working_days,
  coalesce(sum(d.final_lop), 0) as lop_days,
  count(*) filter (where d.status = 'NO_SHIFT')::int as no_shift_days,
  count(*) filter (where d.status = 'WEEK_OFF')::int as week_off_days,
  count(*) filter (where d.status = 'HOLIDAY')::int as holiday_days,
  count(*) filter (
    where d.status not in ('WEEK_OFF', 'HOLIDAY', 'NO_SHIFT')
  )::int - t.expected_working_days as working_days_minus_expected
from public.employees e
join (
  values
    ('20260031', 18),
    ('20260032', 14),
    ('20260033', 9)
) as t(employee_code, expected_working_days) on t.employee_code = e.employee_code
join public.payroll_runs r on r.period = '2026-09'
join public.attendance_day_reviews d
  on d.employee_id = e.id
 and d.import_id = r.attendance_import_id
group by e.employee_code, e.full_name, e.joining_date, t.expected_working_days
order by e.employee_code;

-- 1f. Day-status breakdown (why payable is 18 / 14 / 9, not 22 / 16 / 10 calendar days)
select
  e.employee_code,
  e.full_name,
  d.status,
  count(*)::int as days,
  min(d.attendance_date) as first_date,
  max(d.attendance_date) as last_date
from public.employees e
join public.payroll_runs r on r.period = '2026-09'
join public.attendance_day_reviews d
  on d.employee_id = e.id
 and d.import_id = r.attendance_import_id
where e.employee_code in ('20260031', '20260032', '20260033')
group by e.employee_code, e.full_name, d.status
order by e.employee_code, d.status;

-- 1g. Proposed slip money (what STEP 2 will insert). Review net before applying.
with targets as (
  select * from (
    values
      ('20260031'::text, date '2026-09-09', 18::numeric),
      ('20260032'::text, date '2026-09-15', 14::numeric),
      ('20260033'::text, date '2026-09-21',  9::numeric)
  ) t(employee_code, joined_on, expected_working_days)
),
run as (
  select r.*
  from public.payroll_runs r
  where r.period = '2026-09'
  limit 1
),
comp as (
  select distinct on (c.employee_id) c.*
  from public.employee_compensation c
  join public.employees e on e.id = c.employee_id
  join targets t on t.employee_code = e.employee_code
  where c.effective_from <= date '2026-09-30'
  order by c.employee_id, c.effective_from desc
),
days as (
  select
    d.employee_id,
    count(*) filter (where d.status not in ('WEEK_OFF', 'HOLIDAY', 'NO_SHIFT'))::numeric as working_days,
    coalesce(sum(d.final_lop), 0)::numeric as lop_days
  from public.attendance_day_reviews d
  join run r on r.attendance_import_id = d.import_id
  join public.employees e on e.id = d.employee_id
  join targets t on t.employee_code = e.employee_code
  group by d.employee_id
)
select
  e.employee_code,
  e.full_name,
  t.joined_on as expected_joining_date,
  e.joining_date as db_joining_date,
  30 as calendar_days,
  t.expected_working_days,
  days.working_days,
  days.lop_days,
  (c.basic + c.da + c.hra + c.fuel + c.incentives + c.other_earnings) as monthly_gross,
  round(
    (c.basic + c.da + c.hra + c.fuel + c.incentives + c.other_earnings) / 30::numeric,
    2
  ) as daily_rate,
  round(
    round(
      (c.basic + c.da + c.hra + c.fuel + c.incentives + c.other_earnings) / 30::numeric,
      2
    ) * days.working_days,
    2
  ) as payable_gross,
  round(
    round(
      (c.basic + c.da + c.hra + c.fuel + c.incentives + c.other_earnings) / 30::numeric,
      2
    ) * days.lop_days,
    2
  ) as lop_amount,
  round(
    round(
      round(
        (c.basic + c.da + c.hra + c.fuel + c.incentives + c.other_earnings) / 30::numeric,
        2
      ) * days.working_days,
      2
    )
    - c.professional_tax - c.tds - c.employee_welfare - c.kpi - c.other_deductions
    - round(
        round(
          (c.basic + c.da + c.hra + c.fuel + c.incentives + c.other_earnings) / 30::numeric,
          2
        ) * days.lop_days,
        2
      ),
    2
  ) as net,
  (s.id is not null) as already_has_sep_slip,
  (e.user_id is not null) as has_portal_login,
  (c.id is not null) as has_compensation,
  (co.name is not null) as has_company
from targets t
join public.employees e on e.employee_code = t.employee_code
join run on true
left join comp c on c.employee_id = e.id
left join days on days.employee_id = e.id
left join public.companies co on co.id = e.company_id
left join public.salary_slips s on s.employee_id = e.id and s.run_id = run.id
order by e.employee_code;

-- Stop here. Continue only if:
--   • 3 employees, join dates match, each has company + compensation
--   • 2026-09 payroll run is PUBLISHED
--   • already_has_sep_slip is false for all three
--   • working_days equals expected_working_days (18 / 14 / 9) and lop_days is 0


-- ---------------------------------------------------------------------------
-- STEP 2 — insert 3 published slips + in-app notifications
-- ---------------------------------------------------------------------------

begin;

do $$
declare
  v_run public.payroll_runs%rowtype;
  v_import_id uuid;
  v_calendar_days integer := 30;
  v_inserted int;
  v_notified int;
  r record;
begin
  select * into v_run
  from public.payroll_runs
  where period = '2026-09';
  if not found then
    raise exception 'No payroll run for 2026-09.';
  end if;
  if v_run.status <> 'PUBLISHED' then
    raise exception '2026-09 payroll run status is %, expected PUBLISHED.', v_run.status;
  end if;
  if v_run.attendance_import_id is null then
    raise exception '2026-09 payroll run has no attendance_import_id.';
  end if;
  v_import_id := v_run.attendance_import_id;

  if (
    select count(*) from public.employees
    where employee_code in ('20260031', '20260032', '20260033')
  ) <> 3 then
    raise exception 'Expected exactly 3 employees (20260031, 20260032, 20260033).';
  end if;

  if exists (
    select 1
    from public.salary_slips s
    where s.run_id = v_run.id
      and s.employee_id in (
        select id from public.employees
        where employee_code in ('20260031', '20260032', '20260033')
      )
  ) then
    raise exception 'A 2026-09 salary slip already exists for one of these employees.';
  end if;

  for r in
    select
      e.employee_code,
      e.full_name,
      e.joining_date,
      t.joined_on,
      t.expected_working_days,
      count(*) filter (where d.status not in ('WEEK_OFF', 'HOLIDAY', 'NO_SHIFT'))::numeric as working_days,
      coalesce(sum(d.final_lop), 0)::numeric as lop_days
    from (
      values
        ('20260031', date '2026-09-09', 18::numeric),
        ('20260032', date '2026-09-15', 14::numeric),
        ('20260033', date '2026-09-21',  9::numeric)
    ) as t(employee_code, joined_on, expected_working_days)
    join public.employees e on e.employee_code = t.employee_code
    left join public.attendance_day_reviews d
      on d.employee_id = e.id
     and d.import_id = v_import_id
    group by e.employee_code, e.full_name, e.joining_date, t.joined_on, t.expected_working_days
  loop
    if r.joining_date is distinct from r.joined_on then
      raise exception '% (%): joining_date is %, expected %.',
        r.full_name, r.employee_code, r.joining_date, r.joined_on;
    end if;
    if r.working_days is distinct from r.expected_working_days then
      raise exception '% (%): attendance working days are %, expected % (GM payable). Inspect STEP 1e/1f.',
        r.full_name, r.employee_code, r.working_days, r.expected_working_days;
    end if;
    if r.lop_days <> 0 then
      raise exception '% (%): LOP is %, expected 0.',
        r.full_name, r.employee_code, r.lop_days;
    end if;
  end loop;

  insert into public.salary_slips (
    run_id,
    employee_id,
    employee_code,
    employee_name,
    designation_name,
    department_name,
    company_name,
    company_address,
    company_logo_path,
    pan_masked,
    bank_account_masked,
    bank_name_masked,
    ifsc_masked,
    basic,
    da,
    hra,
    fuel,
    incentives,
    other_earnings,
    professional_tax,
    tds,
    employee_welfare,
    kpi,
    other_deductions,
    calendar_days,
    working_days,
    gross,
    daily_rate,
    lop_days,
    lop_amount,
    net,
    particulars
  )
  select
    v_run.id,
    e.id,
    e.employee_code,
    e.full_name,
    des.name,
    dep.name,
    co.name,
    co.address,
    co.logo_storage_path,
    nullif(btrim(pay.pan), ''),
    nullif(btrim(pay.bank_account_number), ''),
    nullif(btrim(pay.bank_name), ''),
    nullif(btrim(pay.ifsc), ''),
    c.basic,
    c.da,
    c.hra,
    c.fuel,
    c.incentives,
    c.other_earnings,
    c.professional_tax,
    c.tds,
    c.employee_welfare,
    c.kpi,
    c.other_deductions,
    v_calendar_days,
    days.working_days,
    days.monthly_gross,
    days.daily_rate,
    days.lop_days,
    days.lop_amount,
    days.net,
    days.particulars
  from (
    values
      ('20260031', date '2026-09-09', 18::numeric),
      ('20260032', date '2026-09-15', 14::numeric),
      ('20260033', date '2026-09-21',  9::numeric)
  ) as t(employee_code, joined_on, expected_working_days)
  join public.employees e on e.employee_code = t.employee_code
  join public.companies co on co.id = e.company_id
  left join public.designations des on des.id = e.designation_id
  left join public.departments dep on dep.id = e.department_id
  left join public.employee_payment pay on pay.employee_id = e.id
  join lateral (
    select c0.*
    from public.employee_compensation c0
    where c0.employee_id = e.id
      and c0.effective_from <= date '2026-09-30'
    order by c0.effective_from desc
    limit 1
  ) c on true
  join lateral (
    select
      count(*) filter (where d.status not in ('WEEK_OFF', 'HOLIDAY', 'NO_SHIFT'))::numeric as working_days,
      coalesce(sum(d.final_lop), 0)::numeric as lop_days,
      round((c.basic + c.da + c.hra + c.fuel + c.incentives + c.other_earnings)::numeric, 2) as monthly_gross,
      round(
        (c.basic + c.da + c.hra + c.fuel + c.incentives + c.other_earnings)::numeric
          / v_calendar_days::numeric,
        2
      ) as daily_rate,
      round(
        round(
          (c.basic + c.da + c.hra + c.fuel + c.incentives + c.other_earnings)::numeric
            / v_calendar_days::numeric,
          2
        )
        * (count(*) filter (where d.status not in ('WEEK_OFF', 'HOLIDAY', 'NO_SHIFT'))::numeric),
        2
      ) as payable_gross,
      round(
        round(
          (c.basic + c.da + c.hra + c.fuel + c.incentives + c.other_earnings)::numeric
            / v_calendar_days::numeric,
          2
        )
        * coalesce(sum(d.final_lop), 0)::numeric,
        2
      ) as lop_amount,
      round(
        round(
          round(
            (c.basic + c.da + c.hra + c.fuel + c.incentives + c.other_earnings)::numeric
              / v_calendar_days::numeric,
            2
          )
          * (count(*) filter (where d.status not in ('WEEK_OFF', 'HOLIDAY', 'NO_SHIFT'))::numeric),
          2
        )
        - c.professional_tax - c.tds - c.employee_welfare - c.kpi - c.other_deductions
        - round(
            round(
              (c.basic + c.da + c.hra + c.fuel + c.incentives + c.other_earnings)::numeric
                / v_calendar_days::numeric,
              2
            )
            * coalesce(sum(d.final_lop), 0)::numeric,
            2
          ),
        2
      ) as net,
      jsonb_build_object(
        'cl', coalesce(sum(
          case
            when d.leave_type_name is null then 0
            when upper(coalesce(lt.code, '')) = 'CL'
              or lower(d.leave_type_name) like '%casual%'
            then case when d.leave_duration = 'half' then 0.5 else 1 end
            else 0
          end
        ), 0),
        'sl', coalesce(sum(
          case
            when d.leave_type_name is null then 0
            when upper(coalesce(lt.code, '')) = 'SL'
              or lower(d.leave_type_name) like '%sick%'
            then case when d.leave_duration = 'half' then 0.5 else 1 end
            else 0
          end
        ), 0),
        'ml', coalesce(sum(
          case
            when d.leave_type_name is null then 0
            when upper(coalesce(lt.code, '')) = 'ML'
              or lower(d.leave_type_name) like '%menstrual%'
            then case when d.leave_duration = 'half' then 0.5 else 1 end
            else 0
          end
        ), 0),
        'el', coalesce(sum(
          case
            when d.leave_type_name is null then 0
            when upper(coalesce(lt.code, '')) = 'EL'
              or lower(d.leave_type_name) like '%earned%'
              or lower(d.leave_type_name) like '%privilege%'
            then case when d.leave_duration = 'half' then 0.5 else 1 end
            else 0
          end
        ), 0),
        'maternityPaternity', coalesce(sum(
          case
            when d.leave_type_name is null then 0
            when upper(coalesce(lt.code, '')) in ('MAT', 'PAT')
              or lower(d.leave_type_name) like '%maternity%'
              or lower(d.leave_type_name) like '%paternity%'
            then case when d.leave_duration = 'half' then 0.5 else 1 end
            else 0
          end
        ), 0),
        'missPunch', count(*) filter (where d.status = 'MISSING_PUNCH'),
        'permissionsCount', count(distinct d.attendance_date) filter (where coalesce(d.permission_minutes, 0) > 0),
        'permissionHours', round((coalesce(sum(d.permission_minutes), 0)::numeric / 60), 2),
        'lateDays', count(*) filter (where d.status = 'LATE'),
        'absent', count(*) filter (where d.status = 'ABSENT'),
        'totalLop', round(coalesce(sum(d.final_lop), 0)::numeric, 2)
      ) as particulars
    from public.attendance_day_reviews d
    left join public.leave_types lt
      on lower(lt.name) = lower(d.leave_type_name)
    where d.employee_id = e.id
      and d.import_id = v_import_id
  ) days on true
  where co.name is not null
    and c.id is not null;

  get diagnostics v_inserted = row_count;
  if v_inserted <> 3 then
    raise exception 'Expected to insert 3 salary slips, inserted %. Check company + compensation in STEP 1.', v_inserted;
  end if;

  insert into public.notifications (user_id, type, title, message, reference_type, reference_id)
  select
    e.user_id,
    'payroll',
    'September salary slip',
    'Your September salary slip is published. Open it to view or print.',
    'salary_slip',
    s.id::text
  from public.salary_slips s
  join public.employees e on e.id = s.employee_id
  where s.run_id = v_run.id
    and e.employee_code in ('20260031', '20260032', '20260033')
    and e.user_id is not null
    and not exists (
      select 1
      from public.notifications n
      where n.user_id = e.user_id
        and n.reference_type = 'salary_slip'
        and n.reference_id = s.id::text
    );
  get diagnostics v_notified = row_count;

  update public.attendance_imports i
  set salary_slip_employee_ids = (
    select array_agg(distinct x order by x)
    from unnest(
      coalesce(i.salary_slip_employee_ids, '{}'::uuid[])
      || (
        select array_agg(e.id)
        from public.employees e
        where e.employee_code in ('20260031', '20260032', '20260033')
      )
    ) as x
  )
  where i.id = v_import_id
    and i.salary_slip_employee_ids is not null;

  raise notice 'Inserted % Sep 2026 salary slips. In-app notifications: %.', v_inserted, v_notified;
end $$;

commit;


-- ---------------------------------------------------------------------------
-- STEP 3 — verify
-- ---------------------------------------------------------------------------

select
  s.id as slip_id,
  s.employee_code,
  s.employee_name,
  s.joining_date_check,
  s.calendar_days,
  s.working_days,
  s.lop_days,
  s.basic,
  s.da,
  s.hra,
  s.fuel,
  s.incentives,
  s.other_earnings,
  s.gross as monthly_gross,
  s.daily_rate,
  s.lop_amount,
  s.professional_tax,
  s.employee_welfare,
  s.net,
  s.particulars
from (
  select
    s.*,
    e.joining_date as joining_date_check
  from public.salary_slips s
  join public.payroll_runs r on r.id = s.run_id
  join public.employees e on e.id = s.employee_id
  where r.period = '2026-09'
    and r.status = 'PUBLISHED'
    and s.employee_code in ('20260031', '20260032', '20260033')
) s
order by s.employee_code;

select
  e.employee_code,
  e.full_name,
  n.id as notification_id,
  n.title,
  n.reference_id as slip_id,
  n.created_at
from public.employees e
left join public.notifications n
  on n.user_id = e.user_id
 and n.type = 'payroll'
 and n.title = 'September salary slip'
where e.employee_code in ('20260031', '20260032', '20260033')
order by e.employee_code;


-- ---------------------------------------------------------------------------
-- STEP 4 — fix working days (do not exclude Sunday)
-- ---------------------------------------------------------------------------
-- STEP 2 used attendance statuses, so Sunday WEEK_OFF was dropped:
--   Sai Teja 21–30 → 9 instead of 10
--   Soumya   15–30 → 14 instead of 16
--   Moulali  09–30 → 18 instead of 22
--
-- Correct rule: every calendar day from joining_date through 2026-09-30
-- inclusive. Sunday counts. LOP stays 0. Gross/CTC unchanged.
--   20260033 Sai Teja  10 days
--   20260032 Soumya    16 days
--   20260031 Moulali   22 days
--
-- Preview first, then the UPDATE.
-- ---------------------------------------------------------------------------

select
  s.employee_code,
  s.employee_name,
  e.joining_date,
  (date '2026-09-30' - e.joining_date) + 1 as new_working_days,
  s.working_days as old_working_days,
  s.calendar_days,
  s.gross,
  s.daily_rate,
  s.lop_days,
  s.net as old_net,
  round(
    round(s.daily_rate * ((date '2026-09-30' - e.joining_date) + 1), 2)
    - s.professional_tax - s.tds - s.employee_welfare - s.kpi - s.other_deductions
    - s.lop_amount,
    2
  ) as new_net
from public.salary_slips s
join public.payroll_runs r on r.id = s.run_id
join public.employees e on e.id = s.employee_id
where r.period = '2026-09'
  and r.status = 'PUBLISHED'
  and s.employee_code in ('20260031', '20260032', '20260033')
order by s.employee_code;

-- Apply (run after the preview looks right)
begin;

do $$
declare
  n int;
begin
  update public.salary_slips s
  set
    working_days = t.new_working_days,
    net = round(
      round(s.daily_rate * t.new_working_days, 2)
      - s.professional_tax - s.tds - s.employee_welfare - s.kpi - s.other_deductions
      - s.lop_amount,
      2
    )
  from (
    values
      ('20260031'::text, 22::numeric),
      ('20260032'::text, 16::numeric),
      ('20260033'::text, 10::numeric)
  ) as t(employee_code, new_working_days),
  public.payroll_runs r
  where s.employee_code = t.employee_code
    and s.run_id = r.id
    and r.period = '2026-09'
    and r.status = 'PUBLISHED'
    and s.lop_days = 0;

  get diagnostics n = row_count;
  if n <> 3 then
    raise exception 'Expected to update 3 Sep 2026 slips, updated %.', n;
  end if;
end $$;

commit;

-- Verify
select
  s.employee_code,
  s.employee_name,
  e.joining_date,
  s.calendar_days,
  s.working_days,
  s.lop_days,
  s.gross as monthly_gross,
  s.daily_rate,
  s.net,
  (s.calendar_days - s.working_days) as non_working_days
from public.salary_slips s
join public.payroll_runs r on r.id = s.run_id
join public.employees e on e.id = s.employee_id
where r.period = '2026-09'
  and s.employee_code in ('20260031', '20260032', '20260033')
order by s.employee_code;
