-- Work types: method (DNA/PCR/Gel/Loading — scale components by how-many Nx)
-- vs recipe (Reagent preparation — composition + optional output lot).

alter table public.inventory_lab_activities
  add column if not exists usage_mode text not null default 'method'
    check (usage_mode in ('method', 'recipe'));

comment on column public.inventory_lab_activities.usage_mode is
  'method = reaction/extraction with Nx multiplier; recipe = reagent prep composition (+ optional output lot).';

update public.inventory_lab_activities
set usage_mode = 'method',
    description = case name
      when 'DNA Extraction' then 'Choose a DNA extraction method, set how many (Nx), then submit. Component volumes scale with N.'
      when 'PCR reaction' then 'Choose a PCR method, set how many reactions (Nx), then submit. Component volumes scale with N.'
      when 'Gel preparation' then 'Choose a gel method, set how many (Nx), then submit. Component volumes scale with N.'
      when 'DNA loading' then 'Choose a loading method, set how many (Nx), then submit. Component volumes scale with N.'
      else description
    end,
    updated_at = now()
where name in ('DNA Extraction', 'PCR reaction', 'Gel preparation', 'DNA loading');

update public.inventory_lab_activities
set usage_mode = 'recipe',
    description = 'Prepare reagents from composition recipes (e.g. 6X Loading Dye).',
    updated_at = now()
where name = 'Reagent preparation';

alter table public.inventory_lab_usage_submissions
  add column if not exists quantity_multiplier numeric(12, 4) not null default 1
    check (quantity_multiplier > 0);

comment on column public.inventory_lab_usage_submissions.quantity_multiplier is
  'Nx scale applied to method component volumes (1 = 1X). Recipes typically stay at 1.';

notify pgrst, 'reload schema';
