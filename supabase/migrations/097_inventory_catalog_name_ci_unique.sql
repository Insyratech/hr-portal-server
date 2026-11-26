-- Case-insensitive unique catalog name within a category (trim + lower).
-- Prevents double entries like "Ethanol" / "ethanol" in the same category.
-- Existing exact unique (category_id, name) stays; this index is stricter.

do $$
declare
  r record;
  keeper_id uuid;
  dup_id uuid;
  removed integer := 0;
  has_lots boolean := to_regclass('public.inventory_lots') is not null;
  has_prep boolean := to_regclass('public.inventory_prep_sessions') is not null;
  has_plastic boolean := to_regclass('public.inventory_plastic_stock') is not null;
  has_alert_log boolean := to_regclass('public.inventory_alert_log') is not null;
  has_lab_recipes boolean := to_regclass('public.inventory_lab_recipes') is not null;
  has_lab_components boolean := to_regclass('public.inventory_lab_recipe_components') is not null;
begin
  for r in
    select
      category_id,
      lower(btrim(name)) as name_key
    from public.inventory_catalog_items
    group by 1, 2
    having count(*) > 1
  loop
    select c.id
      into keeper_id
    from public.inventory_catalog_items c
    where c.category_id = r.category_id
      and lower(btrim(c.name)) = r.name_key
    order by c.created_at asc, c.id asc
    limit 1;

    for dup_id in
      select c.id
      from public.inventory_catalog_items c
      where c.category_id = r.category_id
        and lower(btrim(c.name)) = r.name_key
        and c.id <> keeper_id
      order by c.created_at asc, c.id asc
    loop
      if has_lots then
        update public.inventory_lots
        set catalog_item_id = keeper_id
        where catalog_item_id = dup_id;
      end if;

      if has_prep then
        update public.inventory_prep_sessions
        set catalog_item_id = keeper_id
        where catalog_item_id = dup_id;
      end if;

      if has_plastic then
        update public.inventory_plastic_stock
        set catalog_item_id = keeper_id
        where catalog_item_id = dup_id;
      end if;

      if has_alert_log then
        update public.inventory_alert_log
        set catalog_item_id = keeper_id
        where catalog_item_id = dup_id;
      end if;

      if has_lab_recipes then
        update public.inventory_lab_recipes
        set output_catalog_item_id = keeper_id
        where output_catalog_item_id = dup_id;
      end if;

      if has_lab_components then
        update public.inventory_lab_recipe_components
        set catalog_item_id = keeper_id
        where catalog_item_id = dup_id;
      end if;

      delete from public.inventory_catalog_items
      where id = dup_id;

      removed := removed + 1;
    end loop;
  end loop;

  raise notice 'Migration 097: removed % case-duplicate catalog item(s).', removed;
end $$;

create unique index if not exists inventory_catalog_items_category_name_ci_unique
  on public.inventory_catalog_items (category_id, lower(btrim(name)));

notify pgrst, 'reload schema';
