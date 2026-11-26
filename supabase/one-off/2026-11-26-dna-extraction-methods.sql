-- Seed DNA Extraction methods (composition + per-run volumes for Nx scaling).
-- Safe to re-run: skips methods that already exist by name under DNA Extraction.
-- Excludes Sample (not a stock component). catalog_item_id stays NULL — IM links stock via Edit.
-- Does not touch Reagent preparation / PCR / Gel / DNA loading or any other inventory data.

do $$
declare
  v_activity_id uuid;
  v_recipe_id uuid;
begin
  select id into v_activity_id
  from public.inventory_lab_activities
  where name = 'DNA Extraction'
  limit 1;

  if v_activity_id is null then
    insert into public.inventory_lab_activities (name, description, sort_order, status, usage_mode)
    values (
      'DNA Extraction',
      'Choose a DNA extraction method, set how many (Nx), then submit.',
      10,
      'active',
      'method'
    )
    returning id into v_activity_id;
  else
    update public.inventory_lab_activities
    set usage_mode = 'method',
        description = coalesce(
          nullif(trim(description), ''),
          'Choose a DNA extraction method, set how many (Nx), then submit.'
        ),
        updated_at = now()
    where id = v_activity_id;
  end if;

  -- 1. Manual magnetic bead method (saliva)
  if not exists (
    select 1 from public.inventory_lab_recipes
    where activity_id = v_activity_id and name = 'Manual magnetic bead method (saliva)'
  ) then
    insert into public.inventory_lab_recipes (
      activity_id, name, final_volume_value, final_volume_unit, notes, sort_order, status,
      creates_output_lot, output_catalog_item_id
    ) values (
      v_activity_id,
      'Manual magnetic bead method (saliva)',
      null,
      '',
      'Per 1X run. Sample volume on protocol: 500 µL (not stocked).',
      10,
      'active',
      false,
      null
    ) returning id into v_recipe_id;

    insert into public.inventory_lab_recipe_components
      (recipe_id, name, quantity_value, quantity_unit, notes, sort_order, catalog_item_id)
    values
      (v_recipe_id, 'Proteinase K', 20, 'µL', '', 10, null),
      (v_recipe_id, 'Digestion Buffer', 500, 'µL', '', 20, null),
      (v_recipe_id, 'Magnetic beads', 100, 'µL', '', 30, null),
      (v_recipe_id, 'Wash buffer 1', 750, 'µL', '', 40, null),
      (v_recipe_id, 'Wash buffer 2', 1500, 'µL', '', 50, null),
      (v_recipe_id, 'Elution buffer', 100, 'µL', '', 60, null);
  end if;

  -- 2. Manual magnetic bead method (blood)
  if not exists (
    select 1 from public.inventory_lab_recipes
    where activity_id = v_activity_id and name = 'Manual magnetic bead method (blood)'
  ) then
    insert into public.inventory_lab_recipes (
      activity_id, name, final_volume_value, final_volume_unit, notes, sort_order, status,
      creates_output_lot, output_catalog_item_id
    ) values (
      v_activity_id,
      'Manual magnetic bead method (blood)',
      null,
      '',
      'Per 1X run. Sample volume on protocol: 500 µL (not stocked).',
      20,
      'active',
      false,
      null
    ) returning id into v_recipe_id;

    insert into public.inventory_lab_recipe_components
      (recipe_id, name, quantity_value, quantity_unit, notes, sort_order, catalog_item_id)
    values
      (v_recipe_id, 'Proteinase K', 20, 'µL', '', 10, null),
      (v_recipe_id, 'Digestion Buffer', 500, 'µL', '', 20, null),
      (v_recipe_id, 'Magnetic beads', 100, 'µL', '', 30, null),
      (v_recipe_id, 'Wash buffer 1', 750, 'µL', '', 40, null),
      (v_recipe_id, 'Wash buffer 2', 1500, 'µL', '', 50, null),
      (v_recipe_id, 'Elution buffer', 100, 'µL', '', 60, null);
  end if;

  -- 3. Automated magnetic bead method (saliva)
  if not exists (
    select 1 from public.inventory_lab_recipes
    where activity_id = v_activity_id and name = 'Automated magnetic bead method (saliva)'
  ) then
    insert into public.inventory_lab_recipes (
      activity_id, name, final_volume_value, final_volume_unit, notes, sort_order, status,
      creates_output_lot, output_catalog_item_id
    ) values (
      v_activity_id,
      'Automated magnetic bead method (saliva)',
      null,
      '',
      'Per 1X run. Sample (saliva) on protocol: 400 µL (not stocked).',
      30,
      'active',
      false,
      null
    ) returning id into v_recipe_id;

    insert into public.inventory_lab_recipe_components
      (recipe_id, name, quantity_value, quantity_unit, notes, sort_order, catalog_item_id)
    values
      (v_recipe_id, 'Proteinase K', 20, 'µL', '', 10, null),
      (v_recipe_id, 'Digestion Buffer', 400, 'µL', '', 20, null),
      (v_recipe_id, 'Magnetic beads', 100, 'µL', '', 30, null),
      (v_recipe_id, 'Wash buffer 1', 600, 'µL', '', 40, null),
      (v_recipe_id, 'Wash buffer 2', 600, 'µL', '', 50, null),
      (v_recipe_id, 'Elution buffer', 100, 'µL', '', 60, null);
  end if;

  -- 4. Automated magnetic bead method (blood)
  if not exists (
    select 1 from public.inventory_lab_recipes
    where activity_id = v_activity_id and name = 'Automated magnetic bead method (blood)'
  ) then
    insert into public.inventory_lab_recipes (
      activity_id, name, final_volume_value, final_volume_unit, notes, sort_order, status,
      creates_output_lot, output_catalog_item_id
    ) values (
      v_activity_id,
      'Automated magnetic bead method (blood)',
      null,
      '',
      'Per 1X run. Sample (blood) on protocol: 200 µL (not stocked).',
      40,
      'active',
      false,
      null
    ) returning id into v_recipe_id;

    insert into public.inventory_lab_recipe_components
      (recipe_id, name, quantity_value, quantity_unit, notes, sort_order, catalog_item_id)
    values
      (v_recipe_id, 'Proteinase K', 20, 'µL', '', 10, null),
      (v_recipe_id, 'Digestion Buffer', 400, 'µL', '', 20, null),
      (v_recipe_id, 'Magnetic beads', 100, 'µL', '', 30, null),
      (v_recipe_id, 'Wash buffer 1', 600, 'µL', '', 40, null),
      (v_recipe_id, 'Wash buffer 2', 600, 'µL', '', 50, null),
      (v_recipe_id, 'Elution buffer', 100, 'µL', '', 60, null);
  end if;
end $$;

-- Verify
select
  a.name as activity,
  r.name as method,
  r.sort_order,
  c.sort_order as component_order,
  c.name as component,
  c.quantity_value,
  c.quantity_unit
from public.inventory_lab_recipes r
join public.inventory_lab_activities a on a.id = r.activity_id
left join public.inventory_lab_recipe_components c on c.recipe_id = r.id
where a.name = 'DNA Extraction'
  and r.name in (
    'Manual magnetic bead method (saliva)',
    'Manual magnetic bead method (blood)',
    'Automated magnetic bead method (saliva)',
    'Automated magnetic bead method (blood)'
  )
order by r.sort_order, c.sort_order;
