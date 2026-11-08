begin;

create table public.imars_app_snapshots (
  snapshot_id uuid not null,
  path text not null,
  source_read_time text not null,
  source_updated_at text not null,
  fields jsonb not null check (jsonb_typeof(fields) = 'object'),
  primary key (snapshot_id, path),
  check (split_part(path, '/', 1) in (
    'classes', 'did_you_know', 'generatedQuizRevisions',
    'generatedQuizzes', 'terms', 'users', 'webSettings'
  ))
);

alter table public.imars_app_snapshots enable row level security;
revoke all on public.imars_app_snapshots from public, anon, authenticated, service_role;
grant select, insert, delete on public.imars_app_snapshots to service_role;

commit;
