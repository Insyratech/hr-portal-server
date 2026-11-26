-- Allow lot transfers between usage areas (Stock room → Inside lab).
-- Quantity does not change; only the storage area (central_qr_id) moves.

do $$
declare
  constraint_name text;
begin
  select c.conname
    into constraint_name
  from pg_constraint c
  join pg_class t on t.oid = c.conrelid
  join pg_namespace n on n.oid = t.relnamespace
  where n.nspname = 'public'
    and t.relname = 'inventory_movements'
    and c.contype = 'c'
    and pg_get_constraintdef(c.oid) ilike '%movement_type%';

  if constraint_name is not null then
    execute format('alter table public.inventory_movements drop constraint %I', constraint_name);
  end if;
end $$;

alter table public.inventory_movements
  add constraint inventory_movements_movement_type_check
  check (movement_type in ('receive', 'issue', 'adjust', 'transfer'));

comment on constraint inventory_movements_movement_type_check on public.inventory_movements is
  'receive / issue / adjust / transfer (whole-lot move between usage areas).';

notify pgrst, 'reload schema';
