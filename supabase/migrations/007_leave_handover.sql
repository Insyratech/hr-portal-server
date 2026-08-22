alter table public.leave_applications
  add column if not exists handover_employee_id uuid references public.employees (id) on delete set null;

create index if not exists leave_applications_handover_employee_id_idx
  on public.leave_applications (handover_employee_id);

drop policy if exists leave_applications_select on public.leave_applications;
create policy leave_applications_select on public.leave_applications for select to authenticated
  using (
    exists (select 1 from public.employees e where e.id = employee_id and e.user_id = auth.uid())
    or exists (select 1 from public.employees e where e.id = handover_employee_id and e.user_id = auth.uid())
    or public.authorize('leave.approve')
  );
