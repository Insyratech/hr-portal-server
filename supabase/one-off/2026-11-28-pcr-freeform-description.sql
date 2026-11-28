-- Update PCR reaction hint for freeform Inside lab form (master mix deduct only).
-- Safe to re-run. Does not change master-mix rows or other work types.

update public.inventory_lab_activities
set description =
  'Choose master mix + number of reactions (Nx). Add optional mixture rows (primer/NFW/template). Only master mix deducts: Nx × volume.',
    updated_at = now()
where name = 'PCR reaction'
  and usage_mode = 'pcr';

select id, name, usage_mode, description
from public.inventory_lab_activities
where name = 'PCR reaction';
