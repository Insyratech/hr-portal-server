-- Gel preparation: percentage + volume chart (no methods).
-- Components: Agarose (g), 1X TAE Buffer (mL), EtBr (µL by volume).

alter table public.inventory_lab_activities
  drop constraint if exists inventory_lab_activities_usage_mode_check;

alter table public.inventory_lab_activities
  add constraint inventory_lab_activities_usage_mode_check
  check (usage_mode in ('method', 'recipe', 'gel'));

comment on column public.inventory_lab_activities.usage_mode is
  'method = Nx reaction/extraction; recipe = reagent prep; gel = agarose % + volume chart.';

update public.inventory_lab_activities
set usage_mode = 'gel',
    description = 'Choose agarose % and gel volume. Components (Agarose, TAE Buffer, EtBr) are calculated from the chart.',
    updated_at = now()
where name = 'Gel preparation';

create table if not exists public.inventory_lab_gel_percentages (
  percent numeric(12, 4) primary key
    check (percent > 0)
);

create table if not exists public.inventory_lab_gel_volumes (
  volume_ml numeric(12, 4) primary key
    check (volume_ml > 0)
);

create table if not exists public.inventory_lab_gel_etbr_by_volume (
  volume_ml numeric(12, 4) primary key
    references public.inventory_lab_gel_volumes (volume_ml) on delete cascade,
  etbr_ul numeric(12, 4) not null
    check (etbr_ul >= 0)
);

create table if not exists public.inventory_lab_gel_components (
  id uuid primary key default gen_random_uuid(),
  activity_id uuid not null references public.inventory_lab_activities (id) on delete cascade,
  component_key text not null
    check (component_key in ('agarose', 'buffer', 'stain')),
  name text not null,
  catalog_item_id uuid references public.inventory_catalog_items (id) on delete set null,
  sort_order integer not null default 100,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint inventory_lab_gel_components_activity_key_unique unique (activity_id, component_key)
);

create index if not exists inventory_lab_gel_components_activity_idx
  on public.inventory_lab_gel_components (activity_id, sort_order);

drop trigger if exists inventory_lab_gel_components_set_updated_at on public.inventory_lab_gel_components;
create trigger inventory_lab_gel_components_set_updated_at
  before update on public.inventory_lab_gel_components
  for each row execute procedure public.set_updated_at();

alter table public.inventory_lab_gel_components enable row level security;
drop policy if exists inventory_lab_gel_components_all on public.inventory_lab_gel_components;
create policy inventory_lab_gel_components_all on public.inventory_lab_gel_components
  for all to authenticated
  using (
    public.authorize('inventory.lab.manage')
    or public.authorize('inventory.lots.manage')
  )
  with check (
    public.authorize('inventory.lab.manage')
    or public.authorize('inventory.lots.manage')
  );

alter table public.inventory_lab_usage_submissions
  add column if not exists gel_percent numeric(12, 4),
  add column if not exists gel_volume_ml numeric(12, 4);

comment on column public.inventory_lab_usage_submissions.gel_percent is
  'Agarose % w/v chosen for gel preparation runs.';
comment on column public.inventory_lab_usage_submissions.gel_volume_ml is
  'Target gel volume (mL) for gel preparation runs.';

-- Chart options (Agarose Gel Preparation Chart)
insert into public.inventory_lab_gel_percentages (percent) values
  (0.8), (1), (2), (3), (3.5), (5)
on conflict (percent) do nothing;

insert into public.inventory_lab_gel_volumes (volume_ml) values
  (30), (50), (100), (200)
on conflict (volume_ml) do nothing;

insert into public.inventory_lab_gel_etbr_by_volume (volume_ml, etbr_ul) values
  (30, 0.5),
  (50, 2),
  (100, 4),
  (200, 6)
on conflict (volume_ml) do update set etbr_ul = excluded.etbr_ul;

-- Default gel stock-link rows for Gel preparation (catalog_item_id left null for IM)
insert into public.inventory_lab_gel_components (activity_id, component_key, name, sort_order, catalog_item_id)
select a.id, v.component_key, v.name, v.sort_order, null
from public.inventory_lab_activities a
cross join (
  values
    ('agarose', 'Agarose', 10),
    ('buffer', '1X TAE Buffer', 20),
    ('stain', 'EtBr', 30)
) as v(component_key, name, sort_order)
where a.name = 'Gel preparation'
on conflict (activity_id, component_key) do update
  set name = excluded.name,
      sort_order = excluded.sort_order,
      updated_at = now();

notify pgrst, 'reload schema';
