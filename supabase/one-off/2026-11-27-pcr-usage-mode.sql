-- Flip PCR reaction to usage_mode = pcr (master mix + reactions).
-- Safe to re-run. Does not touch DNA / Gel / Loading / Reagent or master-mix rows.

alter table public.inventory_lab_activities
  drop constraint if exists inventory_lab_activities_usage_mode_check;

alter table public.inventory_lab_activities
  add constraint inventory_lab_activities_usage_mode_check
  check (usage_mode in ('method', 'pcr', 'recipe', 'gel'));

comment on column public.inventory_lab_activities.usage_mode is
  'method = DNA/Loading Nx; pcr = master mix + reactions; recipe = reagent prep; gel = agarose % + volume chart.';

update public.inventory_lab_activities
set usage_mode = 'pcr',
    description = 'Choose a master mix, set how many reactions (Nx). Default volume is 10 µL per reaction (editable). Deduction = Nx × volume.',
    updated_at = now()
where name = 'PCR reaction';

select id, name, usage_mode, description
from public.inventory_lab_activities
where name = 'PCR reaction';
