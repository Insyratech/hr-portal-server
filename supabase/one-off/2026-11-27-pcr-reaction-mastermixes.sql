-- Seed PCR reaction master mixes (default 10 µL per 1X reaction).
-- Safe to re-run: skips mixes that already exist by name under PCR reaction.
-- catalog_item_id stays NULL — IM links stock via Edit on Lab recipes.
-- Does not touch DNA Extraction / Gel / DNA loading / Reagent preparation.
-- Requires usage_mode 'pcr' allowed (see 102_inventory_lab_pcr_mode.sql / 2026-11-27-pcr-usage-mode.sql).

alter table public.inventory_lab_activities
  drop constraint if exists inventory_lab_activities_usage_mode_check;

alter table public.inventory_lab_activities
  add constraint inventory_lab_activities_usage_mode_check
  check (usage_mode in ('method', 'pcr', 'recipe', 'gel'));

do $$
declare
  v_activity_id uuid;
  v_recipe_id uuid;
begin
  select id into v_activity_id
  from public.inventory_lab_activities
  where name = 'PCR reaction'
  limit 1;

  if v_activity_id is null then
    insert into public.inventory_lab_activities (name, description, sort_order, status, usage_mode)
    values (
      'PCR reaction',
      'Choose a master mix, set how many reactions (Nx). Default volume is 10 µL per reaction (editable). Deduction = Nx × volume.',
      20,
      'active',
      'pcr'
    )
    returning id into v_activity_id;
  else
    update public.inventory_lab_activities
    set usage_mode = 'pcr',
        description = 'Choose a master mix, set how many reactions (Nx). Default volume is 10 µL per reaction (editable). Deduction = Nx × volume.',
        updated_at = now()
    where id = v_activity_id;
  end if;

  -- 1. Leo 2x Mastermix
  if not exists (
    select 1 from public.inventory_lab_recipes
    where activity_id = v_activity_id and name = 'Leo 2x Mastermix'
  ) then
    insert into public.inventory_lab_recipes (
      activity_id, name, final_volume_value, final_volume_unit, notes, sort_order, status,
      creates_output_lot, output_catalog_item_id
    ) values (
      v_activity_id, 'Leo 2x Mastermix', 10, 'µL',
      'Default 10 µL per 1X reaction. Edit volume on submit if this run differs.',
      10, 'active', false, null
    ) returning id into v_recipe_id;

    insert into public.inventory_lab_recipe_components
      (recipe_id, name, quantity_value, quantity_unit, notes, sort_order, catalog_item_id)
    values
      (v_recipe_id, 'Leo 2x Mastermix', 10, 'µL', 'Per 1X reaction', 10, null);
  end if;

  -- 2. Qiagen HRM Mastermix
  if not exists (
    select 1 from public.inventory_lab_recipes
    where activity_id = v_activity_id and name = 'Qiagen HRM Mastermix'
  ) then
    insert into public.inventory_lab_recipes (
      activity_id, name, final_volume_value, final_volume_unit, notes, sort_order, status,
      creates_output_lot, output_catalog_item_id
    ) values (
      v_activity_id, 'Qiagen HRM Mastermix', 10, 'µL',
      'Default 10 µL per 1X reaction. Edit volume on submit if this run differs.',
      20, 'active', false, null
    ) returning id into v_recipe_id;

    insert into public.inventory_lab_recipe_components
      (recipe_id, name, quantity_value, quantity_unit, notes, sort_order, catalog_item_id)
    values
      (v_recipe_id, 'Qiagen HRM Mastermix', 10, 'µL', 'Per 1X reaction', 10, null);
  end if;

  -- 3. TaKaRa LA Taq DNA Polymerase
  if not exists (
    select 1 from public.inventory_lab_recipes
    where activity_id = v_activity_id and name = 'TaKaRa LA Taq DNA Polymerase'
  ) then
    insert into public.inventory_lab_recipes (
      activity_id, name, final_volume_value, final_volume_unit, notes, sort_order, status,
      creates_output_lot, output_catalog_item_id
    ) values (
      v_activity_id, 'TaKaRa LA Taq DNA Polymerase', 10, 'µL',
      'Default 10 µL per 1X reaction. Edit volume on submit if this run differs.',
      30, 'active', false, null
    ) returning id into v_recipe_id;

    insert into public.inventory_lab_recipe_components
      (recipe_id, name, quantity_value, quantity_unit, notes, sort_order, catalog_item_id)
    values
      (v_recipe_id, 'TaKaRa LA Taq DNA Polymerase', 10, 'µL', 'Per 1X reaction', 10, null);
  end if;

  -- 4. Phusion™ DNA Polymerase (NEB - M05305)
  if not exists (
    select 1 from public.inventory_lab_recipes
    where activity_id = v_activity_id and name = 'Phusion™ DNA Polymerase (NEB - M05305)'
  ) then
    insert into public.inventory_lab_recipes (
      activity_id, name, final_volume_value, final_volume_unit, notes, sort_order, status,
      creates_output_lot, output_catalog_item_id
    ) values (
      v_activity_id, 'Phusion™ DNA Polymerase (NEB - M05305)', 10, 'µL',
      'Default 10 µL per 1X reaction. Edit volume on submit if this run differs.',
      40, 'active', false, null
    ) returning id into v_recipe_id;

    insert into public.inventory_lab_recipe_components
      (recipe_id, name, quantity_value, quantity_unit, notes, sort_order, catalog_item_id)
    values
      (v_recipe_id, 'Phusion™ DNA Polymerase (NEB - M05305)', 10, 'µL', 'Per 1X reaction', 10, null);
  end if;

  -- 5. Quantinova Probe Mastermix
  if not exists (
    select 1 from public.inventory_lab_recipes
    where activity_id = v_activity_id and name = 'Quantinova Probe Mastermix'
  ) then
    insert into public.inventory_lab_recipes (
      activity_id, name, final_volume_value, final_volume_unit, notes, sort_order, status,
      creates_output_lot, output_catalog_item_id
    ) values (
      v_activity_id, 'Quantinova Probe Mastermix', 10, 'µL',
      'Default 10 µL per 1X reaction. Edit volume on submit if this run differs.',
      50, 'active', false, null
    ) returning id into v_recipe_id;

    insert into public.inventory_lab_recipe_components
      (recipe_id, name, quantity_value, quantity_unit, notes, sort_order, catalog_item_id)
    values
      (v_recipe_id, 'Quantinova Probe Mastermix', 10, 'µL', 'Per 1X reaction', 10, null);
  end if;

  -- 6. TaqMan Probe Mastermix
  if not exists (
    select 1 from public.inventory_lab_recipes
    where activity_id = v_activity_id and name = 'TaqMan Probe Mastermix'
  ) then
    insert into public.inventory_lab_recipes (
      activity_id, name, final_volume_value, final_volume_unit, notes, sort_order, status,
      creates_output_lot, output_catalog_item_id
    ) values (
      v_activity_id, 'TaqMan Probe Mastermix', 10, 'µL',
      'Default 10 µL per 1X reaction. Edit volume on submit if this run differs.',
      60, 'active', false, null
    ) returning id into v_recipe_id;

    insert into public.inventory_lab_recipe_components
      (recipe_id, name, quantity_value, quantity_unit, notes, sort_order, catalog_item_id)
    values
      (v_recipe_id, 'TaqMan Probe Mastermix', 10, 'µL', 'Per 1X reaction', 10, null);
  end if;

  -- 7. Hemo Klen Taq (NEB)
  if not exists (
    select 1 from public.inventory_lab_recipes
    where activity_id = v_activity_id and name = 'Hemo Klen Taq (NEB)'
  ) then
    insert into public.inventory_lab_recipes (
      activity_id, name, final_volume_value, final_volume_unit, notes, sort_order, status,
      creates_output_lot, output_catalog_item_id
    ) values (
      v_activity_id, 'Hemo Klen Taq (NEB)', 10, 'µL',
      'Default 10 µL per 1X reaction. Edit volume on submit if this run differs.',
      70, 'active', false, null
    ) returning id into v_recipe_id;

    insert into public.inventory_lab_recipe_components
      (recipe_id, name, quantity_value, quantity_unit, notes, sort_order, catalog_item_id)
    values
      (v_recipe_id, 'Hemo Klen Taq (NEB)', 10, 'µL', 'Per 1X reaction', 10, null);
  end if;

  -- 8. HotStart Taq DNA Polymerase (TaKaRa)
  if not exists (
    select 1 from public.inventory_lab_recipes
    where activity_id = v_activity_id and name = 'HotStart Taq DNA Polymerase (TaKaRa)'
  ) then
    insert into public.inventory_lab_recipes (
      activity_id, name, final_volume_value, final_volume_unit, notes, sort_order, status,
      creates_output_lot, output_catalog_item_id
    ) values (
      v_activity_id, 'HotStart Taq DNA Polymerase (TaKaRa)', 10, 'µL',
      'Default 10 µL per 1X reaction. Edit volume on submit if this run differs.',
      80, 'active', false, null
    ) returning id into v_recipe_id;

    insert into public.inventory_lab_recipe_components
      (recipe_id, name, quantity_value, quantity_unit, notes, sort_order, catalog_item_id)
    values
      (v_recipe_id, 'HotStart Taq DNA Polymerase (TaKaRa)', 10, 'µL', 'Per 1X reaction', 10, null);
  end if;

  -- 9. HotStart Taq DNA Polymerase (NEB)
  if not exists (
    select 1 from public.inventory_lab_recipes
    where activity_id = v_activity_id and name = 'HotStart Taq DNA Polymerase (NEB)'
  ) then
    insert into public.inventory_lab_recipes (
      activity_id, name, final_volume_value, final_volume_unit, notes, sort_order, status,
      creates_output_lot, output_catalog_item_id
    ) values (
      v_activity_id, 'HotStart Taq DNA Polymerase (NEB)', 10, 'µL',
      'Default 10 µL per 1X reaction. Edit volume on submit if this run differs.',
      90, 'active', false, null
    ) returning id into v_recipe_id;

    insert into public.inventory_lab_recipe_components
      (recipe_id, name, quantity_value, quantity_unit, notes, sort_order, catalog_item_id)
    values
      (v_recipe_id, 'HotStart Taq DNA Polymerase (NEB)', 10, 'µL', 'Per 1X reaction', 10, null);
  end if;
end $$;

-- Verify
select
  a.name as work_type,
  r.sort_order,
  r.name as master_mix,
  r.final_volume_value,
  r.final_volume_unit,
  c.name as component,
  c.quantity_value,
  c.quantity_unit
from public.inventory_lab_recipes r
join public.inventory_lab_activities a on a.id = r.activity_id
left join public.inventory_lab_recipe_components c on c.recipe_id = r.id
where a.name = 'PCR reaction'
order by r.sort_order, c.sort_order;
