-- ONE-OFF: run in the Supabase SQL editor. Do not re-run after you add real employees.
-- Keeps Super Admin (SA-001 / superadmin@example.com) and Naveen HR (ID20250018 / naveen.insyra@gmail.com).
-- Deletes every other employee row and leftover Auth users so those emails can be used again.

begin;

create temporary table keep_ids (id uuid primary key);

insert into keep_ids (id)
select e.id
from public.employees e
where e.employee_code in ('SA-001', 'ID20250018')
   or lower(e.email) in ('superadmin@example.com', 'naveen.insyra@gmail.com')
on conflict do nothing;

insert into keep_ids (id)
select e.id
from public.employees e
join public.employee_roles er on er.employee_id = e.id
join public.roles r on r.id = er.role_id
where r.code = 'SUPER_ADMIN'
on conflict do nothing;

create temporary table drop_ids as
select e.id
from public.employees e
where e.id not in (select id from keep_ids);

-- Point leftover imports at Super Admin so uploaded_by does not block the delete.
update public.attendance_imports i
set uploaded_by = (
  select e.id from public.employees e
  where e.employee_code = 'SA-001'
  limit 1
)
where i.uploaded_by in (select id from drop_ids)
  and exists (select 1 from public.employees e where e.employee_code = 'SA-001');

update public.employees
set manager_id = null
where manager_id in (select id from drop_ids);

delete from public.leave_ledger
where employee_id in (select id from drop_ids);

delete from public.leave_applications
where employee_id in (select id from drop_ids);

delete from public.grievance_assignments
where assignee_id in (select id from drop_ids)
   or assigned_by in (select id from drop_ids)
   or grievance_id in (select id from public.grievances where employee_id in (select id from drop_ids));

delete from public.grievance_comments
where author_id in (select id from drop_ids)
   or grievance_id in (select id from public.grievances where employee_id in (select id from drop_ids));

delete from public.grievance_attachments
where uploaded_by in (select id from drop_ids)
   or grievance_id in (select id from public.grievances where employee_id in (select id from drop_ids));

delete from public.grievances
where employee_id in (select id from drop_ids);

delete from public.attendance_day_reviews
where employee_id in (select id from drop_ids);

delete from public.attendance_corrections
where employee_id in (select id from drop_ids);

delete from public.attendance_records
where employee_id in (select id from drop_ids);

delete from public.salary_slips
where employee_id in (select id from drop_ids);

delete from public.employees
where id in (select id from drop_ids);

delete from auth.users u
where not exists (
  select 1 from public.employees e where e.user_id = u.id
);

commit;
