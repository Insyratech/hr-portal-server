-- Allow employees to revoke (cancel) a PENDING work permission before HR decides.
-- CANCELLED does not count toward the monthly quota; same date can be requested again.

alter table public.work_permissions
  drop constraint if exists work_permissions_status_check;

alter table public.work_permissions
  add constraint work_permissions_status_check
  check (status in ('PENDING', 'APPROVED', 'REJECTED', 'CANCELLED'));

-- Employees may update only their own PENDING row (to CANCELLED via app/API).
drop policy if exists work_permissions_update on public.work_permissions;
create policy work_permissions_update on public.work_permissions
  for update to authenticated
  using (
    public.authorize('work_permission.approve')
    or (
      public.authorize('work_permission.apply')
      and status = 'PENDING'
      and exists (
        select 1 from public.employees e
        where e.id = employee_id and e.user_id = auth.uid()
      )
    )
  )
  with check (
    public.authorize('work_permission.approve')
    or (
      public.authorize('work_permission.apply')
      and status = 'CANCELLED'
      and exists (
        select 1 from public.employees e
        where e.id = employee_id and e.user_id = auth.uid()
      )
    )
  );

comment on constraint work_permissions_status_check on public.work_permissions is
  'PENDING|APPROVED|REJECTED|CANCELLED. CANCELLED = employee revoke before HR decision; restores quota.';

notify pgrst, 'reload schema';
