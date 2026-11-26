-- Seed Reagent preparation recipes (composition only).
-- Safe to re-run: skips recipes that already exist by name under Reagent preparation.
-- catalog_item_id / output_catalog_item_id stay NULL — IM links stock via Edit later.
-- Does not touch DNA Extraction / PCR / Gel / DNA loading or any other inventory data.

do $$
declare
  v_activity_id uuid;
  v_recipe_id uuid;
begin
  select id into v_activity_id
  from public.inventory_lab_activities
  where name = 'Reagent preparation'
  limit 1;

  if v_activity_id is null then
    insert into public.inventory_lab_activities (name, description, sort_order, status)
    values (
      'Reagent preparation',
      'Prepare reagents from composition recipes (e.g. 6X Loading Dye).',
      50,
      'active'
    )
    returning id into v_activity_id;
  end if;

  -- ---------------------------------------------------------------------------
  -- Helper: insert recipe + components only when that recipe name is missing
  -- ---------------------------------------------------------------------------

  -- 1. 6X Loading Dye (3 mL)
  if not exists (
    select 1 from public.inventory_lab_recipes
    where activity_id = v_activity_id and name = '6X Loading Dye'
  ) then
    insert into public.inventory_lab_recipes (
      activity_id, name, final_volume_value, final_volume_unit, notes, sort_order, status,
      creates_output_lot, output_catalog_item_id
    ) values (
      v_activity_id, '6X Loading Dye', 3, 'mL', 'Reagent composition', 10, 'active', false, null
    ) returning id into v_recipe_id;

    insert into public.inventory_lab_recipe_components
      (recipe_id, name, quantity_value, quantity_unit, notes, sort_order, catalog_item_id)
    values
      (v_recipe_id, 'Bromophenol Blue powder', 7.5, 'mg', '', 10, null),
      (v_recipe_id, '3% Xylene Cyanol solution', 200, 'µL', '', 20, null),
      (v_recipe_id, '10% SDS solution', 150, 'µL', '', 30, null),
      (v_recipe_id, '0.5 M K₂EDTA (pH 8.0)', 60, 'µL', '', 40, null),
      (v_recipe_id, '100% Glycerol', 1.1, 'mL', '', 50, null),
      (v_recipe_id, 'Milli-Q Water', 1.49, 'mL', 'approximately; make up to 3 mL', 60, null);
  end if;

  -- 2. 1% Agarose Gel (100 mL)
  if not exists (
    select 1 from public.inventory_lab_recipes
    where activity_id = v_activity_id and name = '1% Agarose Gel'
  ) then
    insert into public.inventory_lab_recipes (
      activity_id, name, final_volume_value, final_volume_unit, notes, sort_order, status,
      creates_output_lot, output_catalog_item_id
    ) values (
      v_activity_id, '1% Agarose Gel', 100, 'mL', 'Reagent composition', 20, 'active', false, null
    ) returning id into v_recipe_id;

    insert into public.inventory_lab_recipe_components
      (recipe_id, name, quantity_value, quantity_unit, notes, sort_order, catalog_item_id)
    values
      (v_recipe_id, 'Agarose powder', 1, 'g', '', 10, null),
      (v_recipe_id, '1X TAE or 1X TBE buffer', 100, 'mL', '', 20, null),
      (v_recipe_id, 'Ethidium Bromide (10 mg/mL)', 4, 'µL', '', 30, null);
  end if;

  -- 3. Ethidium Bromide (EtBr) Stock Solution (500 µL)
  if not exists (
    select 1 from public.inventory_lab_recipes
    where activity_id = v_activity_id and name = 'Ethidium Bromide (EtBr) Stock Solution'
  ) then
    insert into public.inventory_lab_recipes (
      activity_id, name, final_volume_value, final_volume_unit, notes, sort_order, status,
      creates_output_lot, output_catalog_item_id
    ) values (
      v_activity_id,
      'Ethidium Bromide (EtBr) Stock Solution',
      500,
      'µL',
      'Final preparation: 500 µL aqueous solution. Stock concentration: 10 mg/mL.',
      30,
      'active',
      false,
      null
    ) returning id into v_recipe_id;

    insert into public.inventory_lab_recipe_components
      (recipe_id, name, quantity_value, quantity_unit, notes, sort_order, catalog_item_id)
    values
      (v_recipe_id, 'Ethidium Bromide powder', 5, 'mg', '', 10, null),
      (v_recipe_id, 'Milli-Q Water', 500, 'µL', '', 20, null);
  end if;

  -- 4. 0.1% DEPC-Treated Water (~1 L)
  if not exists (
    select 1 from public.inventory_lab_recipes
    where activity_id = v_activity_id and name = '0.1% DEPC-Treated Water'
  ) then
    insert into public.inventory_lab_recipes (
      activity_id, name, final_volume_value, final_volume_unit, notes, sort_order, status,
      creates_output_lot, output_catalog_item_id
    ) values (
      v_activity_id,
      '0.1% DEPC-Treated Water',
      1,
      'L',
      'Total preparation volume: approx. 1 L. Final DEPC concentration: 0.1% (v/v).',
      40,
      'active',
      false,
      null
    ) returning id into v_recipe_id;

    insert into public.inventory_lab_recipe_components
      (recipe_id, name, quantity_value, quantity_unit, notes, sort_order, catalog_item_id)
    values
      (v_recipe_id, 'Autoclaved Milli-Q Water', 1, 'L', '', 10, null),
      (v_recipe_id, 'Concentrated DEPC', 1, 'mL', '', 20, null);
  end if;

  -- 5. 2M Tris-HCl (Without pH Adjustment) (1 L)
  if not exists (
    select 1 from public.inventory_lab_recipes
    where activity_id = v_activity_id and name = '2M Tris-HCl (Without pH Adjustment)'
  ) then
    insert into public.inventory_lab_recipes (
      activity_id, name, final_volume_value, final_volume_unit, notes, sort_order, status,
      creates_output_lot, output_catalog_item_id
    ) values (
      v_activity_id,
      '2M Tris-HCl (Without pH Adjustment)',
      1,
      'L',
      'Total final volume: 1 L',
      50,
      'active',
      false,
      null
    ) returning id into v_recipe_id;

    insert into public.inventory_lab_recipe_components
      (recipe_id, name, quantity_value, quantity_unit, notes, sort_order, catalog_item_id)
    values
      (v_recipe_id, 'Tris-HCl powder (Molecular Biology Grade, ≥99%)', 315.8, 'g', '', 10, null),
      (v_recipe_id, 'Milli-Q Water', null, 'L', 'make up to 1 L', 20, null);
  end if;

  -- 6. 3M Potassium Chloride (KCl) Solution (100 mL)
  -- (Document listed this twice as #6 and #7 — seed once only.)
  if not exists (
    select 1 from public.inventory_lab_recipes
    where activity_id = v_activity_id and name = '3M Potassium Chloride (KCl) Solution'
  ) then
    insert into public.inventory_lab_recipes (
      activity_id, name, final_volume_value, final_volume_unit, notes, sort_order, status,
      creates_output_lot, output_catalog_item_id
    ) values (
      v_activity_id,
      '3M Potassium Chloride (KCl) Solution',
      100,
      'mL',
      'Total final volume: 100 mL',
      60,
      'active',
      false,
      null
    ) returning id into v_recipe_id;

    insert into public.inventory_lab_recipe_components
      (recipe_id, name, quantity_value, quantity_unit, notes, sort_order, catalog_item_id)
    values
      (v_recipe_id, 'Potassium Chloride (KCl) powder', 22.37, 'g', '', 10, null),
      (v_recipe_id, 'Milli-Q Water', null, 'mL', 'make up to 100 mL', 20, null);
  end if;

  -- 7. 50X TAE Buffer (1 L)  [document #8]
  if not exists (
    select 1 from public.inventory_lab_recipes
    where activity_id = v_activity_id and name = '50X TAE Buffer'
  ) then
    insert into public.inventory_lab_recipes (
      activity_id, name, final_volume_value, final_volume_unit, notes, sort_order, status,
      creates_output_lot, output_catalog_item_id
    ) values (
      v_activity_id, '50X TAE Buffer', 1, 'L', 'Total final volume: 1 L', 70, 'active', false, null
    ) returning id into v_recipe_id;

    insert into public.inventory_lab_recipe_components
      (recipe_id, name, quantity_value, quantity_unit, notes, sort_order, catalog_item_id)
    values
      (v_recipe_id, 'Tris Base', 242.0, 'g', '', 10, null),
      (v_recipe_id, 'Disodium EDTA Dihydrate (Na₂EDTA·2H₂O)', 37.2, 'g', '', 20, null),
      (v_recipe_id, 'Glacial Acetic Acid', 57.1, 'mL', '', 30, null);
  end if;

  -- 8. 10% SDS (Sodium Dodecyl Sulphate) Solution (100 mL)  [document #9]
  if not exists (
    select 1 from public.inventory_lab_recipes
    where activity_id = v_activity_id and name = '10% SDS (Sodium Dodecyl Sulphate) Solution'
  ) then
    insert into public.inventory_lab_recipes (
      activity_id, name, final_volume_value, final_volume_unit, notes, sort_order, status,
      creates_output_lot, output_catalog_item_id
    ) values (
      v_activity_id,
      '10% SDS (Sodium Dodecyl Sulphate) Solution',
      100,
      'mL',
      'Total final volume: 100 mL',
      80,
      'active',
      false,
      null
    ) returning id into v_recipe_id;

    insert into public.inventory_lab_recipe_components
      (recipe_id, name, quantity_value, quantity_unit, notes, sort_order, catalog_item_id)
    values
      (v_recipe_id, 'SDS powder', 10, 'g', '', 10, null),
      (v_recipe_id, 'Milli-Q Water', null, 'mL', 'make up to 100 mL', 20, null);
  end if;

  -- 9. 6M Sodium Chloride (NaCl) Solution (1 L)  [document #10]
  if not exists (
    select 1 from public.inventory_lab_recipes
    where activity_id = v_activity_id and name = '6M Sodium Chloride (NaCl) Solution'
  ) then
    insert into public.inventory_lab_recipes (
      activity_id, name, final_volume_value, final_volume_unit, notes, sort_order, status,
      creates_output_lot, output_catalog_item_id
    ) values (
      v_activity_id,
      '6M Sodium Chloride (NaCl) Solution',
      1,
      'L',
      'Total final volume: 1 L',
      90,
      'active',
      false,
      null
    ) returning id into v_recipe_id;

    insert into public.inventory_lab_recipe_components
      (recipe_id, name, quantity_value, quantity_unit, notes, sort_order, catalog_item_id)
    values
      (v_recipe_id, 'Sodium Chloride (NaCl) powder', 350.6, 'g', '', 10, null),
      (v_recipe_id, 'Milli-Q Water', null, 'L', 'make up to 1 L', 20, null);
  end if;

  -- 10. 0.1M EDTA Solution (pH 8.0) (100 mL)  [document #12]
  if not exists (
    select 1 from public.inventory_lab_recipes
    where activity_id = v_activity_id and name = '0.1M EDTA Solution (pH 8.0)'
  ) then
    insert into public.inventory_lab_recipes (
      activity_id, name, final_volume_value, final_volume_unit, notes, sort_order, status,
      creates_output_lot, output_catalog_item_id
    ) values (
      v_activity_id,
      '0.1M EDTA Solution (pH 8.0)',
      100,
      'mL',
      'Make up to 100 mL; adjust to pH 8.0',
      100,
      'active',
      false,
      null
    ) returning id into v_recipe_id;

    insert into public.inventory_lab_recipe_components
      (recipe_id, name, quantity_value, quantity_unit, notes, sort_order, catalog_item_id)
    values
      (v_recipe_id, 'EDTA Free Acid (H₄EDTA)', 29.224, 'g', '', 10, null),
      (v_recipe_id, 'Potassium Hydroxide (KOH) pellets', 11.222, 'g', 'approximately; adjust to pH 8.0', 20, null),
      (v_recipe_id, 'Milli-Q Water', null, 'mL', 'make up to 100 mL', 30, null);
  end if;

  -- 11. 0.4M Bis-Tris Buffer (pH 6.5) (1 L)  [document #13]
  if not exists (
    select 1 from public.inventory_lab_recipes
    where activity_id = v_activity_id and name = '0.4M Bis-Tris Buffer (pH 6.5)'
  ) then
    insert into public.inventory_lab_recipes (
      activity_id, name, final_volume_value, final_volume_unit, notes, sort_order, status,
      creates_output_lot, output_catalog_item_id
    ) values (
      v_activity_id,
      '0.4M Bis-Tris Buffer (pH 6.5)',
      1,
      'L',
      'Total final volume: 1 L; adjust to pH 6.5',
      110,
      'active',
      false,
      null
    ) returning id into v_recipe_id;

    insert into public.inventory_lab_recipe_components
      (recipe_id, name, quantity_value, quantity_unit, notes, sort_order, catalog_item_id)
    values
      (v_recipe_id, 'Bis-Tris Free Base', 83.7, 'g', '', 10, null),
      (v_recipe_id, 'Concentrated Hydrochloric Acid (HCl, 37%)', null, 'mL', '~35–45 mL; adjust to pH 6.5', 20, null),
      (v_recipe_id, 'Milli-Q Water', null, 'L', 'make up to 1 L', 30, null);
  end if;

  -- 12. TE Buffer (10 mM Tris, 1 mM EDTA, pH 8.0) (100 mL)  [document #14]
  if not exists (
    select 1 from public.inventory_lab_recipes
    where activity_id = v_activity_id and name = 'TE Buffer (10 mM Tris, 1 mM EDTA, pH 8.0)'
  ) then
    insert into public.inventory_lab_recipes (
      activity_id, name, final_volume_value, final_volume_unit, notes, sort_order, status,
      creates_output_lot, output_catalog_item_id
    ) values (
      v_activity_id,
      'TE Buffer (10 mM Tris, 1 mM EDTA, pH 8.0)',
      100,
      'mL',
      'Total final volume: 100 mL; adjust pH to 8.0',
      120,
      'active',
      false,
      null
    ) returning id into v_recipe_id;

    insert into public.inventory_lab_recipe_components
      (recipe_id, name, quantity_value, quantity_unit, notes, sort_order, catalog_item_id)
    values
      (v_recipe_id, 'Tris-HCl powder', 157.6, 'mg', '', 10, null),
      (v_recipe_id, 'Disodium EDTA Dihydrate (Na₂EDTA·2H₂O)', 37.2, 'mg', '', 20, null),
      (v_recipe_id, 'Milli-Q Water', null, 'mL', 'make up to 100 mL', 30, null),
      (v_recipe_id, 'Sodium Hydroxide (NaOH)', null, '', 'as required to adjust pH to 8.0', 40, null);
  end if;

  -- 13. 10N Sodium Hydroxide (NaOH) (100 mL)  [document #15]
  if not exists (
    select 1 from public.inventory_lab_recipes
    where activity_id = v_activity_id and name = '10N Sodium Hydroxide (NaOH)'
  ) then
    insert into public.inventory_lab_recipes (
      activity_id, name, final_volume_value, final_volume_unit, notes, sort_order, status,
      creates_output_lot, output_catalog_item_id
    ) values (
      v_activity_id,
      '10N Sodium Hydroxide (NaOH)',
      100,
      'mL',
      'Total final volume: 100 mL',
      130,
      'active',
      false,
      null
    ) returning id into v_recipe_id;

    insert into public.inventory_lab_recipe_components
      (recipe_id, name, quantity_value, quantity_unit, notes, sort_order, catalog_item_id)
    values
      (v_recipe_id, 'Sodium Hydroxide (NaOH) pellets', 40, 'g', '', 10, null),
      (v_recipe_id, 'Milli-Q Water', null, 'mL', 'make up to 100 mL', 20, null);
  end if;

  -- 14. 1N Hydrochloric Acid (HCl) (100 mL)  [document #16]
  if not exists (
    select 1 from public.inventory_lab_recipes
    where activity_id = v_activity_id and name = '1N Hydrochloric Acid (HCl)'
  ) then
    insert into public.inventory_lab_recipes (
      activity_id, name, final_volume_value, final_volume_unit, notes, sort_order, status,
      creates_output_lot, output_catalog_item_id
    ) values (
      v_activity_id,
      '1N Hydrochloric Acid (HCl)',
      100,
      'mL',
      'Total final volume: 100 mL',
      140,
      'active',
      false,
      null
    ) returning id into v_recipe_id;

    insert into public.inventory_lab_recipe_components
      (recipe_id, name, quantity_value, quantity_unit, notes, sort_order, catalog_item_id)
    values
      (v_recipe_id, 'Concentrated Hydrochloric Acid (HCl, 37%)', 8.3, 'mL', '', 10, null),
      (v_recipe_id, 'Milli-Q Water', null, 'mL', 'make up to 100 mL', 20, null);
  end if;

end $$;

-- Verify
select
  r.sort_order,
  r.name as recipe,
  r.final_volume_value,
  r.final_volume_unit,
  count(c.id) as components,
  bool_or(c.catalog_item_id is not null) as any_stock_link
from public.inventory_lab_recipes r
join public.inventory_lab_activities a on a.id = r.activity_id
left join public.inventory_lab_recipe_components c on c.recipe_id = r.id
where a.name = 'Reagent preparation'
group by r.id, r.sort_order, r.name, r.final_volume_value, r.final_volume_unit
order by r.sort_order, r.name;
