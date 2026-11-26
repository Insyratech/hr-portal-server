-- Lab SOPs: Drive-like folders + PDF files (zstd-compressed in Storage).
-- Inventory Manager uploads PDF only; linked optionally to lab recipes for Inside lab preview.

insert into public.permissions (code, description) values
  ('inventory.sops.manage', 'Manage lab SOP folders and PDF files')
on conflict (code) do nothing;

insert into public.role_permissions (role_id, permission_id)
select r.id, p.id
from public.roles r
cross join public.permissions p
where r.code = 'INVENTORY_MANAGER'
  and p.code = 'inventory.sops.manage'
on conflict do nothing;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'inventory-sops',
  'inventory-sops',
  false,
  20971520,
  array['application/zstd', 'application/octet-stream']::text[]
)
on conflict (id) do update
set
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists inventory_sops_storage_select on storage.objects;
create policy inventory_sops_storage_select on storage.objects for select to authenticated
  using (
    bucket_id = 'inventory-sops'
    and (
      public.authorize('inventory.sops.manage')
      or public.authorize('inventory.lab.manage')
      or public.authorize('inventory.lots.manage')
    )
  );

create table if not exists public.inventory_sop_folders (
  id uuid primary key default gen_random_uuid(),
  parent_id uuid references public.inventory_sop_folders (id) on delete restrict,
  name text not null,
  sort_order integer not null default 100,
  status text not null default 'active'
    check (status in ('active', 'inactive')),
  created_by uuid references public.employees (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint inventory_sop_folders_name_nonempty check (length(trim(name)) > 0)
);

create unique index if not exists inventory_sop_folders_root_name_uidx
  on public.inventory_sop_folders (lower(name))
  where parent_id is null;

create unique index if not exists inventory_sop_folders_child_name_uidx
  on public.inventory_sop_folders (parent_id, lower(name))
  where parent_id is not null;

create index if not exists inventory_sop_folders_parent_idx
  on public.inventory_sop_folders (parent_id, sort_order, name);

drop trigger if exists inventory_sop_folders_set_updated_at on public.inventory_sop_folders;
create trigger inventory_sop_folders_set_updated_at
  before update on public.inventory_sop_folders
  for each row execute procedure public.set_updated_at();

alter table public.inventory_sop_folders enable row level security;
drop policy if exists inventory_sop_folders_all on public.inventory_sop_folders;
create policy inventory_sop_folders_all on public.inventory_sop_folders
  for all to authenticated
  using (
    public.authorize('inventory.sops.manage')
    or public.authorize('inventory.lab.manage')
    or public.authorize('inventory.lots.manage')
  )
  with check (
    public.authorize('inventory.sops.manage')
    or public.authorize('inventory.lab.manage')
    or public.authorize('inventory.lots.manage')
  );

create table if not exists public.inventory_sop_files (
  id uuid primary key default gen_random_uuid(),
  folder_id uuid not null references public.inventory_sop_folders (id) on delete restrict,
  title text not null,
  original_file_name text not null,
  storage_path text not null unique,
  content_type text not null default 'application/pdf',
  original_size_bytes integer not null check (original_size_bytes > 0),
  compressed_size_bytes integer not null check (compressed_size_bytes > 0),
  compression text not null default 'zstd' check (compression = 'zstd'),
  uploaded_by uuid references public.employees (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint inventory_sop_files_title_nonempty check (length(trim(title)) > 0),
  constraint inventory_sop_files_pdf_only check (content_type = 'application/pdf')
);

create unique index if not exists inventory_sop_files_folder_title_uidx
  on public.inventory_sop_files (folder_id, lower(title));

create index if not exists inventory_sop_files_folder_idx
  on public.inventory_sop_files (folder_id, title);

drop trigger if exists inventory_sop_files_set_updated_at on public.inventory_sop_files;
create trigger inventory_sop_files_set_updated_at
  before update on public.inventory_sop_files
  for each row execute procedure public.set_updated_at();

alter table public.inventory_sop_files enable row level security;
drop policy if exists inventory_sop_files_all on public.inventory_sop_files;
create policy inventory_sop_files_all on public.inventory_sop_files
  for all to authenticated
  using (
    public.authorize('inventory.sops.manage')
    or public.authorize('inventory.lab.manage')
    or public.authorize('inventory.lots.manage')
  )
  with check (
    public.authorize('inventory.sops.manage')
    or public.authorize('inventory.lab.manage')
    or public.authorize('inventory.lots.manage')
  );

alter table public.inventory_lab_recipes
  add column if not exists sop_file_id uuid references public.inventory_sop_files (id) on delete set null;

create index if not exists inventory_lab_recipes_sop_file_idx
  on public.inventory_lab_recipes (sop_file_id)
  where sop_file_id is not null;

-- Mirror Drive root folders (IM can rename / add / deactivate later).
insert into public.inventory_sop_folders (name, sort_order)
select seed.name, seed.sort_order
from (
  values
    ('Equipment SOPs', 10),
    ('Facilities SOP', 20),
    ('management sops', 30),
    ('QA SOPs', 40),
    ('QC SOPs', 50),
    ('Reagents SOPs', 60),
    ('Single page SOPs', 70),
    ('Testing SOPs', 80)
) as seed(name, sort_order)
where not exists (
  select 1
  from public.inventory_sop_folders f
  where f.parent_id is null
    and lower(f.name) = lower(seed.name)
);

notify pgrst, 'reload schema';
