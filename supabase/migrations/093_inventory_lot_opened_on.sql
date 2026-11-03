-- Optional opened date on a measured lot or reagent bottle.
-- Additive. Existing receive still works if this column is not filled.

alter table public.inventory_lots
  add column if not exists opened_on date;
