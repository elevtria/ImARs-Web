begin;

create table public.imars_app_datasets (
  id uuid primary key,
  revision uuid not null default gen_random_uuid()
);

create table public.imars_app_documents (
  dataset_id uuid not null references public.imars_app_datasets(id),
  path text collate "C" not null check (
    path ~ '^([A-Za-z0-9_-]{1,128}/[A-Za-z0-9_-]{1,128})(/[A-Za-z0-9_-]{1,128}/[A-Za-z0-9_-]{1,128})*$'
    and split_part(path, '/', 1) in (
      'classes', 'did_you_know', 'generatedQuizRevisions', 'generatedQuizzes', 'terms', 'users', 'webSettings'
    )
  ),
  collection_path text collate "C" generated always as (regexp_replace(path, '/[^/]+$', '')) stored,
  fields jsonb not null check (jsonb_typeof(fields) = 'object'),
  update_time text not null,
  primary key (dataset_id, path)
);

create index imars_app_documents_collection on public.imars_app_documents (dataset_id, collection_path, path);
create index imars_app_documents_fields on public.imars_app_documents using gin (fields jsonb_path_ops);

alter table public.imars_app_datasets enable row level security;
alter table public.imars_app_documents enable row level security;
revoke all on public.imars_app_datasets, public.imars_app_documents from public, anon, authenticated, service_role;
grant select on public.imars_app_datasets, public.imars_app_documents to service_role;

-- A dataset revision covers authorization and query reads as well as rows
-- being saved. A concurrent change requires the caller to validate again.
create function public.imars_commit_app_documents(dataset uuid, expected_revision uuid, changes jsonb)
returns void
language plpgsql security definer
set search_path = ''
as $$
declare
  current_revision uuid;
  changed_at text;
  change jsonb;
begin
  if changes is null or jsonb_typeof(changes) <> 'array' then
    raise exception using errcode = '22023', message = 'Invalid change batch.';
  end if;
  if jsonb_array_length(changes) not between 1 and 100 or exists (
    select 1 from jsonb_array_elements(changes) as row
    group by row ->> 'path' having count(*) > 1
  ) then
    raise exception using errcode = '22023', message = 'Invalid change batch.';
  end if;

  select revision into current_revision from public.imars_app_datasets where id = dataset for update;
  if current_revision is null or current_revision is distinct from expected_revision then
    raise exception using errcode = '40001', message = 'Application data changed.';
  end if;
  changed_at := to_char(clock_timestamp() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"');

  for change in select value from jsonb_array_elements(changes) loop
    if change ->> 'path' is null or not (change ? 'fields') or not (change ? 'previous') then
      raise exception using errcode = '22023', message = 'Invalid document change.';
    end if;
    if change -> 'fields' = 'null'::jsonb then
      delete from public.imars_app_documents
      where dataset_id = dataset and path = change ->> 'path' and update_time = change ->> 'previous';
    elsif change -> 'previous' = 'null'::jsonb then
      insert into public.imars_app_documents(dataset_id, path, fields, update_time)
      values (dataset, change ->> 'path', change -> 'fields', changed_at)
      on conflict do nothing;
    else
      update public.imars_app_documents
      set fields = change -> 'fields', update_time = changed_at
      where dataset_id = dataset and path = change ->> 'path' and update_time = change ->> 'previous';
    end if;
    if not found then
      raise exception using errcode = '40001', message = 'Application data changed.';
    end if;
  end loop;

  update public.imars_app_datasets set revision = gen_random_uuid() where id = dataset;
end;
$$;

revoke all on function public.imars_commit_app_documents(uuid, uuid, jsonb) from public, anon, authenticated;
grant execute on function public.imars_commit_app_documents(uuid, uuid, jsonb) to service_role;

-- Run as the database owner after verifying the source snapshot.
create function public.imars_seed_app_dataset(source_snapshot uuid, target_dataset uuid, expected_records integer)
returns integer
language plpgsql
set search_path = ''
as $$
declare
  copied integer;
begin
  if expected_records is null or expected_records < 1 then
    raise exception using errcode = '22023', message = 'A positive snapshot record count is required.';
  end if;

  insert into public.imars_app_datasets(id) values (target_dataset);
  insert into public.imars_app_documents(dataset_id, path, fields, update_time)
  select target_dataset, path, fields, source_updated_at
  from public.imars_app_snapshots
  where snapshot_id = source_snapshot;
  get diagnostics copied = row_count;
  if copied <> expected_records then
    raise exception using errcode = '22023', message = 'The staged snapshot count did not match.';
  end if;
  return copied;
end;
$$;

revoke all on function public.imars_seed_app_dataset(uuid, uuid, integer) from public, anon, authenticated, service_role;

create or replace function public.imars_app_scan_page(
  p_dataset uuid, p_collection text, p_desc boolean, p_limit integer, p_offset integer
)
returns table(path text, fields jsonb, update_time text)
language sql stable set search_path = ''
as $$
  with scans as (
    select d.path, d.fields, d.update_time,
      case
        when d.fields -> 'timestamp' ? 'timestampValue' then 1
        when d.fields -> 'timestamp' ? 'stringValue' then 2
        else 0
      end as value_type,
      (d.fields -> 'timestamp' ->> 'timestampValue')::timestamptz as scanned_at,
      (d.fields -> 'timestamp' ->> 'stringValue') collate "C" as scan_text
    from public.imars_app_documents d
    where d.dataset_id = p_dataset and d.collection_path = p_collection
      and p_collection ~ '^users/[A-Za-z0-9_-]{1,128}/recent_scans$'
      and d.fields ? 'timestamp'
  )
  select scans.path, scans.fields, scans.update_time from scans
  order by case when p_desc then value_type end desc,
           case when p_desc then scanned_at end desc,
           case when p_desc then scan_text end desc,
           case when p_desc then scans.path end desc,
           value_type, scanned_at, scan_text, scans.path
  limit least(greatest(p_limit, 0), 250) offset greatest(p_offset, 0);
$$;

revoke all on function public.imars_app_scan_page(uuid, text, boolean, integer, integer) from public, anon, authenticated, service_role;
grant execute on function public.imars_app_scan_page(uuid, text, boolean, integer, integer) to service_role;

create or replace function public.imars_quiz_report(
  p_dataset uuid, p_teacher_uid text, p_teacher_id text, p_section text,
  p_quiz text, p_students text[]
) returns jsonb
language sql stable set search_path = ''
as $$
  with roster as materialized (
    select d.path, split_part(d.path, '/', 2) as student
    from public.imars_app_documents d
    where d.dataset_id = p_dataset and d.collection_path = 'users'
      and d.fields @> jsonb_build_object(
        'role', jsonb_build_object('stringValue', 'student'),
        'classCode', jsonb_build_object('stringValue', p_section))
      and coalesce(d.fields #>> '{active,booleanValue}', 'true') <> 'false'
      and lower(coalesce(d.fields #>> '{status,stringValue}', '')) not in ('inactive', 'disabled', 'deleted', 'archived')
      and coalesce(nullif(d.fields #>> '{teacherId,stringValue}', ''), p_teacher_id) = p_teacher_id
      and (p_students is null or d.path = any(array(select 'users/' || unnest(p_students))))
  ),
  attempts as (
    select r.student, a.path, a.fields, a.fields #>> '{quizId,stringValue}' as quiz,
           a.fields #>> '{submittedAt,timestampValue}' as submitted
    from roster r
    join public.imars_app_documents a on a.dataset_id = p_dataset
      and a.collection_path = r.path || '/generated_quiz_attempts'
    where a.fields @> jsonb_build_object('context', jsonb_build_object('mapValue', jsonb_build_object('fields',
      jsonb_build_object('teacherUid', jsonb_build_object('stringValue', p_teacher_uid),
        'teacherProfileId', jsonb_build_object('stringValue', p_teacher_id),
        'sectionId', jsonb_build_object('stringValue', p_section)))))
      and a.fields #>> '{submittedAt,timestampValue}' is not null
      and (p_quiz is null or a.fields #>> '{quizId,stringValue}' = p_quiz)
  ),
  latest as (
    select distinct on (student, quiz) student, path, quiz, submitted, fields #>> '{status,stringValue}' as status,
      case fields #>> '{status,stringValue}'
        when 'reviewed' then fields #> '{review,mapValue,fields}'
        when 'graded' then fields #> '{receipt,mapValue,fields}'
      end as grade
    from attempts
    where quiz ~ '^[A-Za-z0-9_-]{1,128}$'
    order by student, quiz, submitted::timestamptz desc, path desc
  ),
  scores as (
    select student, split_part(path, '/', 4) as attempt, quiz, submitted, status,
      coalesce(grade #>> '{score,integerValue}', grade #>> '{score,doubleValue}')::numeric as score,
      coalesce(grade #>> '{maximum,integerValue}', grade #>> '{maximum,doubleValue}')::numeric as maximum
    from latest
  ),
  totals as (
    select quiz, count(*) as submitted, round(avg(score * 100 / nullif(maximum, 0))
      filter (where maximum > 0)) as average
    from scores where p_quiz is null
    group by quiz
  )
  select case when p_quiz is null then jsonb_build_object(
    'learners', (select count(*) from roster),
    'items', coalesce((select jsonb_agg(jsonb_build_object(
      'quizId', quiz, 'submitted', submitted, 'average', average)) from totals), '[]'::jsonb)
  ) else jsonb_build_object('items', coalesce((select jsonb_agg(jsonb_build_object(
    'studentId', student, 'attemptId', attempt, 'submittedAtUtc', submitted, 'status', status,
    'score', score, 'maximum', maximum)) from scores), '[]'::jsonb)) end;
$$;

revoke all on function public.imars_quiz_report(uuid, text, text, text, text, text[]) from public, anon, authenticated;
grant execute on function public.imars_quiz_report(uuid, text, text, text, text, text[]) to service_role;

commit;
