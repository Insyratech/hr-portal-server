-- Split leave "approval required" into independent Project Lead and HR flags.
-- Backfill preserves today's behaviour: requires_approval → both PL and HR.

alter table public.leave_types
  add column if not exists requires_pl_approval boolean not null default true;

alter table public.leave_types
  add column if not exists requires_hr_approval boolean not null default true;

update public.leave_types
set
  requires_pl_approval = requires_approval,
  requires_hr_approval = requires_approval
where true;

-- Keep legacy requires_approval as OR of the two flags for older clients/code.
update public.leave_types
set requires_approval = (requires_pl_approval or requires_hr_approval)
where true;

-- Published / draft policy rule JSON: derive PL/HR from existing requires_approval when missing.
update public.leave_policy_rules
set rules = rules
  || jsonb_build_object(
    'requires_pl_approval', coalesce((rules->>'requires_pl_approval')::boolean, coalesce((rules->>'requires_approval')::boolean, true)),
    'requires_hr_approval', coalesce((rules->>'requires_hr_approval')::boolean, coalesce((rules->>'requires_approval')::boolean, true)),
    'requires_approval', (
      coalesce((rules->>'requires_pl_approval')::boolean, coalesce((rules->>'requires_approval')::boolean, true))
      or coalesce((rules->>'requires_hr_approval')::boolean, coalesce((rules->>'requires_approval')::boolean, true))
    )
  )
where true;
