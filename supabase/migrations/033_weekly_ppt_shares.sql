-- Phase 4: CSO weekly PPT archive + share packages to GM + CSO Saturday digest.

create table if not exists public.weekly_ppt_shares (
  id uuid primary key default gen_random_uuid(),
  week_start date not null,
  week_end date not null,
  shared_by uuid not null references public.employees (id) on delete restrict,
  shared_at timestamptz not null default now(),
  file_count integer not null default 0 check (file_count >= 0),
  note text not null default ''
);

create table if not exists public.weekly_ppt_share_items (
  share_id uuid not null references public.weekly_ppt_shares (id) on delete cascade,
  update_id uuid not null references public.weekly_work_updates (id) on delete restrict,
  primary key (share_id, update_id)
);

create index if not exists weekly_ppt_shares_week_start_idx on public.weekly_ppt_shares (week_start);
create index if not exists weekly_ppt_shares_shared_at_idx on public.weekly_ppt_shares (shared_at desc);
create index if not exists weekly_ppt_share_items_update_id_idx on public.weekly_ppt_share_items (update_id);

alter table public.weekly_ppt_shares enable row level security;
alter table public.weekly_ppt_share_items enable row level security;

drop policy if exists weekly_ppt_shares_select on public.weekly_ppt_shares;
create policy weekly_ppt_shares_select on public.weekly_ppt_shares for select to authenticated
  using (public.authorize('work.view'));

drop policy if exists weekly_ppt_share_items_select on public.weekly_ppt_share_items;
create policy weekly_ppt_share_items_select on public.weekly_ppt_share_items for select to authenticated
  using (public.authorize('work.view'));

alter table public.work_reminder_log
  drop constraint if exists work_reminder_log_reminder_kind_check;
alter table public.work_reminder_log
  add constraint work_reminder_log_reminder_kind_check
  check (
    reminder_kind in (
      'monday_priorities',
      'daily_update',
      'daily_update_second',
      'carry_forward',
      'weekly_ppt',
      'weekly_ppt_second',
      'weekly_ppt_cso_digest'
    )
  );

grant all on public.weekly_ppt_shares to service_role;
grant all on public.weekly_ppt_share_items to service_role;

comment on table public.weekly_ppt_shares is
  'CSO → GM weekly PPT packages. Re-share allowed; GM only sees shared weeks.';

notify pgrst, 'reload schema';
