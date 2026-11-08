begin;

create table public.imars_migration_documents (
  snapshot_id uuid not null,
  path text not null check (path ~ '^(users|classes)/[A-Za-z0-9_-]{1,128}$'),
  source_updated_at timestamptz not null,
  data jsonb not null check (jsonb_typeof(data) = 'object'),
  primary key (snapshot_id, path)
);

alter table public.imars_migration_documents enable row level security;
revoke all on public.imars_migration_documents from public, anon, authenticated;
grant select, insert, delete on public.imars_migration_documents to service_role;

commit;
