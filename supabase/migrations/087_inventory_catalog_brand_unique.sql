-- Brand name on catalog items + prevent duplicate catalogue numbers.
-- If duplicate catalogue numbers already exist: keep the oldest row, retarget
-- referencing rows (only for tables that exist in this DB), then delete extras.

alter table public.inventory_catalog_items
  add column if not exists brand_name text not null default '';

comment on column public.inventory_catalog_items.brand_name is
  'Manufacturer / brand for the catalog item (searchable; editable on existing rows).';

-- Resolve duplicate catalogue numbers (case-insensitive, trimmed).
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
begin
  for r in
    select lower(btrim(catalog_number)) as catalog_key
    from public.inventory_catalog_items
    where btrim(catalog_number) <> ''
    group by 1
    having count(*) > 1
  loop
    select c.id
      into keeper_id
    from public.inventory_catalog_items c
    where lower(btrim(c.catalog_number)) = r.catalog_key
    order by c.created_at asc, c.id asc
    limit 1;

    for dup_id in
      select c.id
      from public.inventory_catalog_items c
      where lower(btrim(c.catalog_number)) = r.catalog_key
        and c.id <> keeper_id
      order by c.created_at asc, c.id asc
    loop
      -- Retarget stock / prep only when those tables exist in this environment.
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

      delete from public.inventory_catalog_items
      where id = dup_id;

      removed := removed + 1;
    end loop;
  end loop;

  raise notice 'Migration 087: removed % duplicate catalog item(s).', removed;
end $$;

-- Case-insensitive unique catalogue number when present (empty allowed for legacy rows).
create unique index if not exists inventory_catalog_items_catalog_number_unique
  on public.inventory_catalog_items (lower(btrim(catalog_number)))
  where btrim(catalog_number) <> '';

create index if not exists inventory_catalog_items_brand_name_idx
  on public.inventory_catalog_items (lower(brand_name));

notify pgrst, 'reload schema';
