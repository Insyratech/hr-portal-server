-- Seed remaining Reagent preparation recipes (#15–#44 from lab reagent recipe sheets).
-- Safe to re-run: skips recipes that already exist by name under Reagent preparation.
-- Does not modify DNA / PCR / Gel / DNA loading or existing reagent recipes #1–#14.
-- catalog_item_id stays NULL — IM links stock via Edit later.
-- Empty source entries (AmpReady, Binding Buffer, BPA, Saliva Protect, Gel dissolving buffer)
-- are inserted as placeholders with notes only (no components).

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
    insert into public.inventory_lab_activities (name, description, sort_order, status, usage_mode)
    values (
      'Reagent preparation',
      'Prepare reagents from composition recipes (e.g. 6X Loading Dye).',
      50,
      'active',
      'recipe'
    )
    returning id into v_activity_id;
  else
    update public.inventory_lab_activities
    set usage_mode = 'recipe',
        updated_at = now()
    where id = v_activity_id;
  end if;

  -- 15. Digestion buffer / Lysis Buffer (250 mL)
  if not exists (
    select 1 from public.inventory_lab_recipes
    where activity_id = v_activity_id and name = 'Digestion buffer / Lysis Buffer'
  ) then
    insert into public.inventory_lab_recipes (
      activity_id, name, final_volume_value, final_volume_unit, notes, sort_order, status,
      creates_output_lot, output_catalog_item_id
    ) values (
      v_activity_id, 'Digestion buffer / Lysis Buffer', 250, 'mL',
      'Total volume: 250 mL', 150, 'active', false, null
    ) returning id into v_recipe_id;

    insert into public.inventory_lab_recipe_components
      (recipe_id, name, quantity_value, quantity_unit, notes, sort_order, catalog_item_id)
    values
      (v_recipe_id, 'Guanidine isothiocyanate', 147.5, 'g', '', 10, null),
      (v_recipe_id, '2.5% Tween-20', 62.5, 'mL', '', 20, null),
      (v_recipe_id, '50 mM Tris hydrochloride', 6.25, 'mL', '', 30, null),
      (v_recipe_id, '25 mM EDTA', 6.25, 'mL', '', 40, null),
      (v_recipe_id, 'Cetyltrimethylammonium bromide', 5, 'g', '', 50, null);
  end if;

  -- 16. Elution buffer (250 mL)
  if not exists (
    select 1 from public.inventory_lab_recipes
    where activity_id = v_activity_id and name = 'Elution buffer'
  ) then
    insert into public.inventory_lab_recipes (
      activity_id, name, final_volume_value, final_volume_unit, notes, sort_order, status,
      creates_output_lot, output_catalog_item_id
    ) values (
      v_activity_id, 'Elution buffer', 250, 'mL',
      'Total volume: 250 mL', 160, 'active', false, null
    ) returning id into v_recipe_id;

    insert into public.inventory_lab_recipe_components
      (recipe_id, name, quantity_value, quantity_unit, notes, sort_order, catalog_item_id)
    values
      (v_recipe_id, '2M Tris HCl pH 8.5', 1.25, 'mL', '', 10, null),
      (v_recipe_id, 'Milli-Q Water', null, 'mL', 'make up to 250 mL', 20, null);
  end if;

  -- 17. Wash buffer 2 (250 mL)
  if not exists (
    select 1 from public.inventory_lab_recipes
    where activity_id = v_activity_id and name = 'Wash buffer 2'
  ) then
    insert into public.inventory_lab_recipes (
      activity_id, name, final_volume_value, final_volume_unit, notes, sort_order, status,
      creates_output_lot, output_catalog_item_id
    ) values (
      v_activity_id, 'Wash buffer 2', 250, 'mL',
      'Total volume: 250 mL', 170, 'active', false, null
    ) returning id into v_recipe_id;

    insert into public.inventory_lab_recipe_components
      (recipe_id, name, quantity_value, quantity_unit, notes, sort_order, catalog_item_id)
    values
      (v_recipe_id, '80% Ethanol', 200, 'mL', '', 10, null),
      (v_recipe_id, 'Milli-Q Water', null, 'mL', 'make up to 250 mL', 20, null);
  end if;

  -- 18. Wash buffer 1 (250 mL)
  if not exists (
    select 1 from public.inventory_lab_recipes
    where activity_id = v_activity_id and name = 'Wash buffer 1'
  ) then
    insert into public.inventory_lab_recipes (
      activity_id, name, final_volume_value, final_volume_unit, notes, sort_order, status,
      creates_output_lot, output_catalog_item_id
    ) values (
      v_activity_id, 'Wash buffer 1', 250, 'mL',
      'Total volume: 250 mL', 180, 'active', false, null
    ) returning id into v_recipe_id;

    insert into public.inventory_lab_recipe_components
      (recipe_id, name, quantity_value, quantity_unit, notes, sort_order, catalog_item_id)
    values
      (v_recipe_id, 'Guanidine isothiocyanate', 88.5, 'g', '', 10, null),
      (v_recipe_id, '5% Tween-20', 12.5, 'mL', '', 20, null),
      (v_recipe_id, '40 mM Isopropanol', 25, 'mL', '', 30, null),
      (v_recipe_id, '2 mM EDTA', 500, 'µL', '', 40, null),
      (v_recipe_id, 'bis[2-Hydroxyethyl]amino-tris[hydroxymethyl]methane (bis-Tris)', 75, 'mL', '', 50, null),
      (v_recipe_id, 'N-Lauroylsarcosine Sodium Salt (Sarkosyl Sodium)', 5, 'g', '', 60, null),
      (v_recipe_id, 'Milli-Q Water', null, 'mL', 'make up to 250 mL', 70, null);
  end if;

  -- 19. 2 M Tris-HCl Buffer (pH 8.5) from Tris-HCl (100 mL)
  if not exists (
    select 1 from public.inventory_lab_recipes
    where activity_id = v_activity_id
      and name = '2 M Tris-HCl Buffer (pH 8.5) — from Tris-HCl'
  ) then
    insert into public.inventory_lab_recipes (
      activity_id, name, final_volume_value, final_volume_unit, notes, sort_order, status,
      creates_output_lot, output_catalog_item_id
    ) values (
      v_activity_id, '2 M Tris-HCl Buffer (pH 8.5) — from Tris-HCl', 100, 'mL',
      'Document #19. Adjust pH with 10 N NaOH.', 190, 'active', false, null
    ) returning id into v_recipe_id;

    insert into public.inventory_lab_recipe_components
      (recipe_id, name, quantity_value, quantity_unit, notes, sort_order, catalog_item_id)
    values
      (v_recipe_id, 'Tris HCl', 31.52, 'g', '', 10, null),
      (v_recipe_id, '10 N NaOH', null, 'mL', 'approximately 8–10 mL to adjust pH', 20, null),
      (v_recipe_id, 'Milli-Q Water', null, 'mL', 'make up to 100 mL', 30, null);
  end if;

  -- 20. 2 M Tris-HCl Buffer (pH 8.5) from Tris Base (100 mL)
  if not exists (
    select 1 from public.inventory_lab_recipes
    where activity_id = v_activity_id
      and name = '2 M Tris-HCl Buffer (pH 8.5) — from Tris Base'
  ) then
    insert into public.inventory_lab_recipes (
      activity_id, name, final_volume_value, final_volume_unit, notes, sort_order, status,
      creates_output_lot, output_catalog_item_id
    ) values (
      v_activity_id, '2 M Tris-HCl Buffer (pH 8.5) — from Tris Base', 100, 'mL',
      'Document #20. Adjust pH with 2N HCl.', 200, 'active', false, null
    ) returning id into v_recipe_id;

    insert into public.inventory_lab_recipe_components
      (recipe_id, name, quantity_value, quantity_unit, notes, sort_order, catalog_item_id)
    values
      (v_recipe_id, 'Tris Base', 24.23, 'g', '', 10, null),
      (v_recipe_id, '2N HCl', null, 'mL', 'approximately 8–10 mL to adjust pH', 20, null),
      (v_recipe_id, 'Milli-Q Water', null, 'mL', 'make up to 100 mL', 30, null);
  end if;

  -- 21. 3% Xylene Cyanol (100 mL)
  if not exists (
    select 1 from public.inventory_lab_recipes
    where activity_id = v_activity_id and name = '3% Xylene Cyanol'
  ) then
    insert into public.inventory_lab_recipes (
      activity_id, name, final_volume_value, final_volume_unit, notes, sort_order, status,
      creates_output_lot, output_catalog_item_id
    ) values (
      v_activity_id, '3% Xylene Cyanol', 100, 'mL',
      'Final volume 100 mL', 210, 'active', false, null
    ) returning id into v_recipe_id;

    insert into public.inventory_lab_recipe_components
      (recipe_id, name, quantity_value, quantity_unit, notes, sort_order, catalog_item_id)
    values
      (v_recipe_id, 'Xylene Cyanol ff powder', 3, 'g', '', 10, null),
      (v_recipe_id, 'Milli-Q Water', 100, 'mL', '', 20, null);
  end if;

  -- 22. 10X TBE buffer (1 L)
  if not exists (
    select 1 from public.inventory_lab_recipes
    where activity_id = v_activity_id and name = '10X TBE buffer'
  ) then
    insert into public.inventory_lab_recipes (
      activity_id, name, final_volume_value, final_volume_unit, notes, sort_order, status,
      creates_output_lot, output_catalog_item_id
    ) values (
      v_activity_id, '10X TBE buffer', 1, 'L',
      'pH 8.1 to 8.3. Final volume 1 L.', 220, 'active', false, null
    ) returning id into v_recipe_id;

    insert into public.inventory_lab_recipe_components
      (recipe_id, name, quantity_value, quantity_unit, notes, sort_order, catalog_item_id)
    values
      (v_recipe_id, 'Tris Base', 108, 'g', '', 10, null),
      (v_recipe_id, 'Boric Acid', 55, 'g', '', 20, null),
      (v_recipe_id, 'EDTA', 7.44, 'g', '', 30, null),
      (v_recipe_id, 'Milli-Q Water', null, 'L', 'make up to 1 L', 40, null);
  end if;

  -- 23. 40% Acrylamide - Bisacrylamide (29:1) (100 mL)
  if not exists (
    select 1 from public.inventory_lab_recipes
    where activity_id = v_activity_id and name = '40% Acrylamide - Bisacrylamide (29:1)'
  ) then
    insert into public.inventory_lab_recipes (
      activity_id, name, final_volume_value, final_volume_unit, notes, sort_order, status,
      creates_output_lot, output_catalog_item_id
    ) values (
      v_activity_id, '40% Acrylamide - Bisacrylamide (29:1)', 100, 'mL',
      'Final volume 100 mL', 230, 'active', false, null
    ) returning id into v_recipe_id;

    insert into public.inventory_lab_recipe_components
      (recipe_id, name, quantity_value, quantity_unit, notes, sort_order, catalog_item_id)
    values
      (v_recipe_id, 'Acrylamide', 38.67, 'g', '', 10, null),
      (v_recipe_id, 'Bisacrylamide', 1.33, 'g', '', 20, null),
      (v_recipe_id, 'Milli-Q Water', null, 'mL', 'make up to 100 mL', 30, null);
  end if;

  -- 24. Orange G Loading dye (10 mL)
  if not exists (
    select 1 from public.inventory_lab_recipes
    where activity_id = v_activity_id and name = 'Orange G Loading dye'
  ) then
    insert into public.inventory_lab_recipes (
      activity_id, name, final_volume_value, final_volume_unit, notes, sort_order, status,
      creates_output_lot, output_catalog_item_id
    ) values (
      v_activity_id, 'Orange G Loading dye', 10, 'mL',
      'Final volume 10 mL. Source lists 2M Tris HCl as 50 mL — confirm with lab before use.',
      240, 'active', false, null
    ) returning id into v_recipe_id;

    insert into public.inventory_lab_recipe_components
      (recipe_id, name, quantity_value, quantity_unit, notes, sort_order, catalog_item_id)
    values
      (v_recipe_id, 'Orange G', 25, 'mg', '', 10, null),
      (v_recipe_id, 'Glycerol', 3, 'mL', '', 20, null),
      (v_recipe_id, '2M Tris HCl (pH 8)', 50, 'mL', 'as listed in source document', 30, null),
      (v_recipe_id, '0.5M EDTA', 120, 'µL', '', 40, null),
      (v_recipe_id, 'NFW (Nuclease-Free Water)', 6.78, 'mL', '', 50, null);
  end if;

  -- 25. New Wash Buffer 1 (source title 25 mL; make-up says 100 mL)
  if not exists (
    select 1 from public.inventory_lab_recipes
    where activity_id = v_activity_id and name = 'New Wash Buffer 1'
  ) then
    insert into public.inventory_lab_recipes (
      activity_id, name, final_volume_value, final_volume_unit, notes, sort_order, status,
      creates_output_lot, output_catalog_item_id
    ) values (
      v_activity_id, 'New Wash Buffer 1', 100, 'mL',
      'Source header says 25 mL; make-up instruction is to 100 mL — confirm with lab.',
      250, 'active', false, null
    ) returning id into v_recipe_id;

    insert into public.inventory_lab_recipe_components
      (recipe_id, name, quantity_value, quantity_unit, notes, sort_order, catalog_item_id)
    values
      (v_recipe_id, 'NaCl', 218.75, 'mg', '', 10, null),
      (v_recipe_id, 'Sodium Chloride', 96.25, 'mg', 'as listed separately in source', 20, null),
      (v_recipe_id, '1M Na₂EDTA', 250, 'µL', '', 30, null),
      (v_recipe_id, 'Milli-Q Water', null, 'mL', 'make up to 100 mL', 40, null);
  end if;

  -- 26. 5% Tween 20 (100 mL)
  if not exists (
    select 1 from public.inventory_lab_recipes
    where activity_id = v_activity_id and name = '5% Tween 20'
  ) then
    insert into public.inventory_lab_recipes (
      activity_id, name, final_volume_value, final_volume_unit, notes, sort_order, status,
      creates_output_lot, output_catalog_item_id
    ) values (
      v_activity_id, '5% Tween 20', 100, 'mL',
      'Volume 100 mL', 260, 'active', false, null
    ) returning id into v_recipe_id;

    insert into public.inventory_lab_recipe_components
      (recipe_id, name, quantity_value, quantity_unit, notes, sort_order, catalog_item_id)
    values
      (v_recipe_id, 'Tween 20', 5, 'mL', '', 10, null),
      (v_recipe_id, 'Milli-Q Water', null, 'mL', 'make up to 100 mL', 20, null);
  end if;

  -- 27. 20% Tween 20 (100 mL)
  if not exists (
    select 1 from public.inventory_lab_recipes
    where activity_id = v_activity_id and name = '20% Tween 20'
  ) then
    insert into public.inventory_lab_recipes (
      activity_id, name, final_volume_value, final_volume_unit, notes, sort_order, status,
      creates_output_lot, output_catalog_item_id
    ) values (
      v_activity_id, '20% Tween 20', 100, 'mL',
      'Volume 100 mL', 270, 'active', false, null
    ) returning id into v_recipe_id;

    insert into public.inventory_lab_recipe_components
      (recipe_id, name, quantity_value, quantity_unit, notes, sort_order, catalog_item_id)
    values
      (v_recipe_id, 'Tween 20', 20, 'mL', '', 10, null),
      (v_recipe_id, 'Milli-Q Water', null, 'mL', 'make up to 100 mL', 20, null);
  end if;

  -- 28. 70% Ethanol (100 mL)
  if not exists (
    select 1 from public.inventory_lab_recipes
    where activity_id = v_activity_id and name = '70% Ethanol'
  ) then
    insert into public.inventory_lab_recipes (
      activity_id, name, final_volume_value, final_volume_unit, notes, sort_order, status,
      creates_output_lot, output_catalog_item_id
    ) values (
      v_activity_id, '70% Ethanol', 100, 'mL',
      'Final volume 100 mL', 280, 'active', false, null
    ) returning id into v_recipe_id;

    insert into public.inventory_lab_recipe_components
      (recipe_id, name, quantity_value, quantity_unit, notes, sort_order, catalog_item_id)
    values
      (v_recipe_id, '95% ethanol', 73.67, 'mL', '', 10, null),
      (v_recipe_id, 'RO water', null, 'mL', 'make up to 100 mL', 20, null);
  end if;

  -- 29. AmpReady (placeholder — no composition in source)
  if not exists (
    select 1 from public.inventory_lab_recipes
    where activity_id = v_activity_id and name = 'AmpReady'
  ) then
    insert into public.inventory_lab_recipes (
      activity_id, name, final_volume_value, final_volume_unit, notes, sort_order, status,
      creates_output_lot, output_catalog_item_id
    ) values (
      v_activity_id, 'AmpReady', null, '',
      'Placeholder: composition not listed in source document.', 290, 'active', false, null
    );
  end if;

  -- 30. Bicarbonate buffer pH 9.5 (1 L)
  if not exists (
    select 1 from public.inventory_lab_recipes
    where activity_id = v_activity_id and name = 'Bicarbonate buffer (pH 9.5)'
  ) then
    insert into public.inventory_lab_recipes (
      activity_id, name, final_volume_value, final_volume_unit, notes, sort_order, status,
      creates_output_lot, output_catalog_item_id
    ) values (
      v_activity_id, 'Bicarbonate buffer (pH 9.5)', 1, 'L',
      'Adjusted to 1 L', 300, 'active', false, null
    ) returning id into v_recipe_id;

    insert into public.inventory_lab_recipe_components
      (recipe_id, name, quantity_value, quantity_unit, notes, sort_order, catalog_item_id)
    values
      (v_recipe_id, 'Sodium bicarbonate (NaHCO₃)', 2.93, 'g', 'MW 84.01 g/mol', 10, null),
      (v_recipe_id, 'Sodium carbonate (Na₂CO₃, anhydrous)', 1.59, 'g', 'MW 105.99 g/mol', 20, null),
      (v_recipe_id, 'Distilled or deionized water', null, 'L', '~950 mL initially; make up / adjust to 1 L', 30, null);
  end if;

  -- 31. 1x PBS (100 mL)
  if not exists (
    select 1 from public.inventory_lab_recipes
    where activity_id = v_activity_id and name = '1x PBS'
  ) then
    insert into public.inventory_lab_recipes (
      activity_id, name, final_volume_value, final_volume_unit, notes, sort_order, status,
      creates_output_lot, output_catalog_item_id
    ) values (
      v_activity_id, '1x PBS', 100, 'mL',
      'Total volume 100 mL', 310, 'active', false, null
    ) returning id into v_recipe_id;

    insert into public.inventory_lab_recipe_components
      (recipe_id, name, quantity_value, quantity_unit, notes, sort_order, catalog_item_id)
    values
      (v_recipe_id, 'Sodium Chloride', 0.8, 'g', '', 10, null),
      (v_recipe_id, 'Potassium Chloride', 0.02, 'g', '', 20, null),
      (v_recipe_id, 'Disodium Hydrogen Phosphate', 0.144, 'g', '', 30, null),
      (v_recipe_id, 'Potassium Dihydrogen Phosphate', 0.02, 'g', '', 40, null);
  end if;

  -- 32. PBS-T 0.05%
  if not exists (
    select 1 from public.inventory_lab_recipes
    where activity_id = v_activity_id and name = 'PBS-T 0.05%'
  ) then
    insert into public.inventory_lab_recipes (
      activity_id, name, final_volume_value, final_volume_unit, notes, sort_order, status,
      creates_output_lot, output_catalog_item_id
    ) values (
      v_activity_id, 'PBS-T 0.05%', 100, 'mL',
      'Source lists Tween 20 as 50 mL with 100 mL PBS — confirm with lab (0.05% often uses µL-scale Tween).',
      320, 'active', false, null
    ) returning id into v_recipe_id;

    insert into public.inventory_lab_recipe_components
      (recipe_id, name, quantity_value, quantity_unit, notes, sort_order, catalog_item_id)
    values
      (v_recipe_id, '1X PBS', 100, 'mL', '', 10, null),
      (v_recipe_id, 'Tween 20', 50, 'mL', 'as listed in source document', 20, null);
  end if;

  -- 33. 0.5 M EDTA (100 mL)
  if not exists (
    select 1 from public.inventory_lab_recipes
    where activity_id = v_activity_id and name = '0.5 M EDTA'
  ) then
    insert into public.inventory_lab_recipes (
      activity_id, name, final_volume_value, final_volume_unit, notes, sort_order, status,
      creates_output_lot, output_catalog_item_id
    ) values (
      v_activity_id, '0.5 M EDTA', 100, 'mL',
      'Total volume 100 mL', 330, 'active', false, null
    ) returning id into v_recipe_id;

    insert into public.inventory_lab_recipe_components
      (recipe_id, name, quantity_value, quantity_unit, notes, sort_order, catalog_item_id)
    values
      (v_recipe_id, 'EDTA Disodium Salt Dihydrate', 18.61, 'g', '', 10, null),
      (v_recipe_id, 'Milli-Q Water', null, 'mL', 'make up to 100 mL', 20, null);
  end if;

  -- 34. Binding Buffer (placeholder)
  if not exists (
    select 1 from public.inventory_lab_recipes
    where activity_id = v_activity_id and name = 'Binding Buffer'
  ) then
    insert into public.inventory_lab_recipes (
      activity_id, name, final_volume_value, final_volume_unit, notes, sort_order, status,
      creates_output_lot, output_catalog_item_id
    ) values (
      v_activity_id, 'Binding Buffer', null, '',
      'Placeholder: composition not listed in source document.', 340, 'active', false, null
    );
  end if;

  -- 35. 5 M Guanidine Thiocyanate (GTC) (1 L)
  if not exists (
    select 1 from public.inventory_lab_recipes
    where activity_id = v_activity_id and name = '5 M Guanidine Thiocyanate (GTC)'
  ) then
    insert into public.inventory_lab_recipes (
      activity_id, name, final_volume_value, final_volume_unit, notes, sort_order, status,
      creates_output_lot, output_catalog_item_id
    ) values (
      v_activity_id, '5 M Guanidine Thiocyanate (GTC)', 1, 'L',
      'Total volume 1 L', 350, 'active', false, null
    ) returning id into v_recipe_id;

    insert into public.inventory_lab_recipe_components
      (recipe_id, name, quantity_value, quantity_unit, notes, sort_order, catalog_item_id)
    values
      (v_recipe_id, 'Guanidine Thiocyanate (GTC)', 590.8, 'g', '', 10, null),
      (v_recipe_id, 'Nuclease-free Water', null, 'L', 'make up to 1 L', 20, null);
  end if;

  -- 36. 1 M D-(+)-Trehalose Dihydrate (1 L)
  if not exists (
    select 1 from public.inventory_lab_recipes
    where activity_id = v_activity_id and name = '1 M D-(+)-Trehalose Dihydrate'
  ) then
    insert into public.inventory_lab_recipes (
      activity_id, name, final_volume_value, final_volume_unit, notes, sort_order, status,
      creates_output_lot, output_catalog_item_id
    ) values (
      v_activity_id, '1 M D-(+)-Trehalose Dihydrate', 1, 'L',
      'Total volume 1 L', 360, 'active', false, null
    ) returning id into v_recipe_id;

    insert into public.inventory_lab_recipe_components
      (recipe_id, name, quantity_value, quantity_unit, notes, sort_order, catalog_item_id)
    values
      (v_recipe_id, 'D-(+)-Trehalose Dihydrate', 378.33, 'g', '', 10, null),
      (v_recipe_id, 'Deionized / Nuclease-free Water', null, 'L', 'make up to 1 L', 20, null);
  end if;

  -- 37. BPA (bisphenol-A) (placeholder)
  if not exists (
    select 1 from public.inventory_lab_recipes
    where activity_id = v_activity_id and name = 'BPA (bisphenol-A)'
  ) then
    insert into public.inventory_lab_recipes (
      activity_id, name, final_volume_value, final_volume_unit, notes, sort_order, status,
      creates_output_lot, output_catalog_item_id
    ) values (
      v_activity_id, 'BPA (bisphenol-A)', null, '',
      'Placeholder: composition not listed in source document.', 370, 'active', false, null
    );
  end if;

  -- 38. Magnetic beads (100 mL)
  if not exists (
    select 1 from public.inventory_lab_recipes
    where activity_id = v_activity_id and name = 'Magnetic beads'
  ) then
    insert into public.inventory_lab_recipes (
      activity_id, name, final_volume_value, final_volume_unit, notes, sort_order, status,
      creates_output_lot, output_catalog_item_id
    ) values (
      v_activity_id, 'Magnetic beads', 100, 'mL',
      'Final volume 100 mL. Process uses larger intermediate water volume (2 L sonicated Milli-Q).',
      380, 'active', false, null
    ) returning id into v_recipe_id;

    insert into public.inventory_lab_recipe_components
      (recipe_id, name, quantity_value, quantity_unit, notes, sort_order, catalog_item_id)
    values
      (v_recipe_id, 'FeSO₄·7H₂O (0.5 M anhydrous)', 1.39, 'g', '', 10, null),
      (v_recipe_id, '0.5 M Iron Chloride Hexahydrate', 2.23, 'g', '', 20, null),
      (v_recipe_id, '10% Ammonia', 40, 'mL', '', 30, null),
      (v_recipe_id, 'Methacrylic acid', 10.6, 'mL', '', 40, null),
      (v_recipe_id, 'Sonicated Milli-Q Water', 2, 'L', '', 50, null),
      (v_recipe_id, 'Potassium persulfate', 0.6, 'g', '', 60, null),
      (v_recipe_id, 'Acetone', 50, 'mL', '', 70, null),
      (v_recipe_id, 'Ethanol', 50, 'mL', '', 80, null),
      (v_recipe_id, '10 mM Tris HCl', 500, 'µL', '', 90, null),
      (v_recipe_id, '1 mM K₂EDTA', 100, 'µL', '', 100, null),
      (v_recipe_id, '0.05% Tween 20', 50, 'µL', '', 110, null),
      (v_recipe_id, 'Milli-Q Water', null, 'mL', 'make up to 100 mL', 120, null);
  end if;

  -- 39. Annealing buffer
  if not exists (
    select 1 from public.inventory_lab_recipes
    where activity_id = v_activity_id and name = 'Annealing buffer'
  ) then
    insert into public.inventory_lab_recipes (
      activity_id, name, final_volume_value, final_volume_unit, notes, sort_order, status,
      creates_output_lot, output_catalog_item_id
    ) values (
      v_activity_id, 'Annealing buffer', null, '',
      'Component volumes as listed in source (includes 100 mL Milli-Q).', 390, 'active', false, null
    ) returning id into v_recipe_id;

    insert into public.inventory_lab_recipe_components
      (recipe_id, name, quantity_value, quantity_unit, notes, sort_order, catalog_item_id)
    values
      (v_recipe_id, '100 mM Tris-HCl', 5, 'mL', '', 10, null),
      (v_recipe_id, '10 mM EDTA', 1, 'mL', '', 20, null),
      (v_recipe_id, '500 mM NaCl', 8.3, 'mL', '', 30, null),
      (v_recipe_id, 'Milli-Q Water', 100, 'mL', '', 40, null);
  end if;

  -- 40. Saliva Protect (placeholder)
  if not exists (
    select 1 from public.inventory_lab_recipes
    where activity_id = v_activity_id and name = 'Saliva Protect'
  ) then
    insert into public.inventory_lab_recipes (
      activity_id, name, final_volume_value, final_volume_unit, notes, sort_order, status,
      creates_output_lot, output_catalog_item_id
    ) values (
      v_activity_id, 'Saliva Protect', null, '',
      'Placeholder: composition not listed in source document.', 400, 'active', false, null
    );
  end if;

  -- 41. 3 M Sodium Acetate Solution (100 mL)
  if not exists (
    select 1 from public.inventory_lab_recipes
    where activity_id = v_activity_id and name = '3 M Sodium Acetate Solution'
  ) then
    insert into public.inventory_lab_recipes (
      activity_id, name, final_volume_value, final_volume_unit, notes, sort_order, status,
      creates_output_lot, output_catalog_item_id
    ) values (
      v_activity_id, '3 M Sodium Acetate Solution', 100, 'mL',
      'Total volume 100 mL', 410, 'active', false, null
    ) returning id into v_recipe_id;

    insert into public.inventory_lab_recipe_components
      (recipe_id, name, quantity_value, quantity_unit, notes, sort_order, catalog_item_id)
    values
      (v_recipe_id, 'Sodium Acetate (Anhydrous)', 24.61, 'g', '', 10, null),
      (v_recipe_id, 'Milli-Q Water', null, 'mL', 'make up to 100 mL', 20, null);
  end if;

  -- 42. 10% Ammonium Persulfate (APS) Solution (100 mL)
  if not exists (
    select 1 from public.inventory_lab_recipes
    where activity_id = v_activity_id and name = '10% Ammonium Persulfate (APS) Solution'
  ) then
    insert into public.inventory_lab_recipes (
      activity_id, name, final_volume_value, final_volume_unit, notes, sort_order, status,
      creates_output_lot, output_catalog_item_id
    ) values (
      v_activity_id, '10% Ammonium Persulfate (APS) Solution', 100, 'mL',
      'Total volume 100 mL', 420, 'active', false, null
    ) returning id into v_recipe_id;

    insert into public.inventory_lab_recipe_components
      (recipe_id, name, quantity_value, quantity_unit, notes, sort_order, catalog_item_id)
    values
      (v_recipe_id, 'Ammonium Persulfate (APS)', 10, 'g', '', 10, null),
      (v_recipe_id, 'Milli-Q Water', null, 'mL', 'make up to 100 mL', 20, null);
  end if;

  -- 43. 1X TBE Buffer (from 10X TBE) (1 L)
  if not exists (
    select 1 from public.inventory_lab_recipes
    where activity_id = v_activity_id and name = '1X TBE Buffer (from 10X TBE)'
  ) then
    insert into public.inventory_lab_recipes (
      activity_id, name, final_volume_value, final_volume_unit, notes, sort_order, status,
      creates_output_lot, output_catalog_item_id
    ) values (
      v_activity_id, '1X TBE Buffer (from 10X TBE)', 1, 'L',
      'Total volume 1 L', 430, 'active', false, null
    ) returning id into v_recipe_id;

    insert into public.inventory_lab_recipe_components
      (recipe_id, name, quantity_value, quantity_unit, notes, sort_order, catalog_item_id)
    values
      (v_recipe_id, '10X TBE Buffer', 100, 'mL', '', 10, null),
      (v_recipe_id, 'Milli-Q Water', null, 'L', 'make up to 1 L', 20, null);
  end if;

  -- 44. Gel dissolving buffer (placeholder)
  if not exists (
    select 1 from public.inventory_lab_recipes
    where activity_id = v_activity_id and name = 'Gel dissolving buffer'
  ) then
    insert into public.inventory_lab_recipes (
      activity_id, name, final_volume_value, final_volume_unit, notes, sort_order, status,
      creates_output_lot, output_catalog_item_id
    ) values (
      v_activity_id, 'Gel dissolving buffer', null, '',
      'Placeholder: composition not listed in source document.', 440, 'active', false, null
    );
  end if;
end $$;

-- Verify all Reagent preparation recipes
select
  r.sort_order,
  r.name as recipe,
  r.final_volume_value,
  r.final_volume_unit,
  count(c.id) as components
from public.inventory_lab_recipes r
join public.inventory_lab_activities a on a.id = r.activity_id
left join public.inventory_lab_recipe_components c on c.recipe_id = r.id
where a.name = 'Reagent preparation'
group by r.id, r.sort_order, r.name, r.final_volume_value, r.final_volume_unit
order by r.sort_order, r.name;
