-- Catalogue / catalog number on inventory catalog items (supplier / MSDS identity).
-- Additive: existing rows get empty string; UI can fill later.

alter table public.inventory_catalog_items
  add column if not exists catalog_number text not null default '';

comment on column public.inventory_catalog_items.catalog_number is
  'Supplier or internal catalogue number shown with the item name.';

notify pgrst, 'reload schema';
