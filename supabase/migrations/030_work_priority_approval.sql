-- Phase 1: per-priority CSO approval before daily work updates.

alter table public.weekly_priorities
  add column if not exists approval_status text not null default 'DRAFT',
  add column if not exists cso_comment text not null default '',
  add column if not exists submitted_at timestamptz,
  add column if not exists approved_at timestamptz,
  add column if not exists approved_by uuid references public.employees (id) on delete set null,
  add column if not exists resubmit_requested_at timestamptz;

alter table public.weekly_priorities drop constraint if exists weekly_priorities_approval_status_check;
alter table public.weekly_priorities
  add constraint weekly_priorities_approval_status_check
  check (approval_status in ('DRAFT', 'SUBMITTED', 'APPROVED', 'RESUBMIT_REQUESTED'));

-- Existing rows stay usable for daily updates until the next planning cycle.
update public.weekly_priorities
set
  approval_status = 'APPROVED',
  approved_at = coalesce(approved_at, now())
where approval_status = 'DRAFT';

create index if not exists weekly_priorities_approval_status_idx
  on public.weekly_priorities (approval_status);

comment on column public.weekly_priorities.approval_status is
  'CSO gate: DRAFT → SUBMITTED → APPROVED | RESUBMIT_REQUESTED. Daily updates require all active priorities APPROVED.';
