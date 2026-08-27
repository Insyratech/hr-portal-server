-- Regular work subtype (Testing / Production / General management / Inventory / Other).
-- Project (R&D) priorities keep using project_id; skill priorities stay unchanged.

alter table public.weekly_priorities
  add column if not exists regular_subtype text,
  add column if not exists regular_subtype_label text;

-- Existing REGULAR rows need a subtype before the new check can apply.
update public.weekly_priorities
set
  regular_subtype = coalesce(regular_subtype, 'GENERAL_MANAGEMENT'),
  project_id = null
where priority_type = 'REGULAR';

update public.weekly_priorities
set
  regular_subtype = null,
  regular_subtype_label = null
where priority_type in ('PROJECT', 'SKILL');

alter table public.weekly_priorities
  drop constraint if exists weekly_priorities_regular_subtype_check;

alter table public.weekly_priorities
  add constraint weekly_priorities_regular_subtype_check
  check (
    regular_subtype is null
    or regular_subtype in (
      'TESTING',
      'PRODUCTION',
      'GENERAL_MANAGEMENT',
      'INVENTORY',
      'OTHER'
    )
  );

alter table public.weekly_priorities
  drop constraint if exists weekly_priorities_type_subtype_check;

alter table public.weekly_priorities
  add constraint weekly_priorities_type_subtype_check
  check (
    (
      priority_type = 'PROJECT'
      and project_id is not null
      and regular_subtype is null
      and (regular_subtype_label is null or btrim(regular_subtype_label) = '')
    )
    or (
      priority_type = 'REGULAR'
      and project_id is null
      and regular_subtype is not null
      and (
        regular_subtype <> 'OTHER'
        or (regular_subtype_label is not null and length(btrim(regular_subtype_label)) > 0)
      )
    )
    or (
      priority_type = 'SKILL'
      and project_id is null
      and regular_subtype is null
      and (regular_subtype_label is null or btrim(regular_subtype_label) = '')
    )
  );

comment on column public.weekly_priorities.regular_subtype is
  'Required when priority_type = REGULAR. Not used for PROJECT or SKILL.';
comment on column public.weekly_priorities.regular_subtype_label is
  'Required when regular_subtype = OTHER. Optional display label otherwise.';
