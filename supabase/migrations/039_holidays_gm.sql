-- Holidays: General Manager owns CRUD; everyone authenticated can read (API + RLS select).

insert into public.permissions (code, description)
values ('holidays.manage', 'Manage organisation holiday calendar')
on conflict (code) do nothing;

insert into public.role_permissions (role_id, permission_id)
select r.id, p.id
from public.roles r
join public.permissions p on p.code = 'holidays.manage'
where r.code = 'GENERAL_MANAGER'
on conflict do nothing;

drop policy if exists holidays_write on public.holidays;
create policy holidays_write on public.holidays for all to authenticated
  using (public.authorize('holidays.manage'))
  with check (public.authorize('holidays.manage'));

notify pgrst, 'reload schema';
