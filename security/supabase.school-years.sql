-- Installs archive support only. This script does NOT close a school year.
begin;

create table if not exists public.imars_school_year_archives (
  id uuid primary key default gen_random_uuid(),
  dataset_id uuid not null references public.imars_app_datasets(id),
  start_year integer not null check (start_year between 2000 and 2100),
  next_year integer not null check (next_year = start_year + 1),
  closed_at timestamptz not null default now(),
  closed_by text not null,
  counts jsonb not null,
  documents jsonb not null,
  mobile_runs jsonb not null,
  mobile_receipts jsonb not null,
  unique (dataset_id, start_year)
);
alter table public.imars_school_year_archives enable row level security;
revoke all on public.imars_school_year_archives from public, anon, authenticated, service_role;
grant select on public.imars_school_year_archives to service_role;

create or replace function public.imars_close_school_year(
  p_dataset uuid, p_revision uuid, p_start_year integer, p_admin_id text
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  current_revision uuid;
  current_year integer;
  archive_id uuid;
  snapshot jsonb;
  runs jsonb;
  receipts jsonb;
  student_uids text[];
  totals jsonb;
  stamp text := to_char(clock_timestamp() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"');
begin
  if p_start_year not between 2000 and 2099 or p_admin_id !~ '^[A-Za-z0-9_-]{1,128}$' then
    raise exception 'Invalid school year request';
  end if;
  -- Serialize mobile writes, then take the dataset lock used by ordinary app
  -- commits. Mobile writes cannot cross the annual snapshot boundary.
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('imars-school-year:production',8393));
  select revision into current_revision from public.imars_app_datasets where id = p_dataset for update;
  if current_revision is distinct from p_revision then
    raise exception 'Records changed; refresh the preview' using errcode = '40001';
  end if;
  select coalesce((fields->'startYear'->>'integerValue')::integer, 2026) into current_year
    from public.imars_app_documents where dataset_id = p_dataset and path = 'webSettings/schoolYear';
  if current_year is distinct from p_start_year then
    raise exception 'The current school year changed' using errcode = '40001';
  end if;
  if not exists (select 1 from public.imars_app_documents where dataset_id = p_dataset
      and path = 'users/' || p_admin_id and fields->'role'->>'stringValue' = 'admin'
      and coalesce(fields->'active'->>'booleanValue', 'true') = 'true') then
    raise exception 'Administrator access is required' using errcode = '42501';
  end if;
  if exists(select 1 from public.imars_school_year_archives where dataset_id = p_dataset and start_year = p_start_year) then
    raise exception 'That school year has already been archived' using errcode = '40001';
  end if;
  select coalesce(array_agg(fields->'uid'->>'stringValue') filter(where fields->'uid'->>'stringValue' is not null), '{}')
    into student_uids from public.imars_app_documents where dataset_id = p_dataset and collection_path = 'users'
    and fields->'role'->>'stringValue' = 'student'
    and (coalesce(fields->'active'->>'booleanValue','true') = 'true'
      or coalesce((fields->'archivedSchoolYear'->>'integerValue')::integer,p_start_year) >= p_start_year);

  -- Keep academic records, not passwords, login sessions or recovery tokens.
  select coalesce(jsonb_agg(jsonb_build_object('path', d.path, 'fields',
    case when d.collection_path = 'users' then
      (select coalesce(jsonb_object_agg(key, value), '{}') from jsonb_each(d.fields)
        where key = any(array['uid','schoolId','role','active','status','name','displayName','fullName','firstName','middleName','middleInitial','lastName',
          'teacherId','classCode','section','sections','subject','gradeSection','gamification','completedQuizzes','archiveReason']))
    else d.fields end, 'update_time', d.update_time) order by d.path), '[]')
    into snapshot from public.imars_app_documents d where d.dataset_id = p_dataset
      and (split_part(d.path,'/',1) in ('classes','terms','generatedQuizzes','generatedQuizRevisions')
        or (d.collection_path = 'users' and (d.fields->'role'->>'stringValue' <> 'student'
          or coalesce(d.fields->'active'->>'booleanValue','true') = 'true'
          or coalesce((d.fields->'archivedSchoolYear'->>'integerValue')::integer,p_start_year) >= p_start_year))
        or d.path ~ '^users/[^/]+/(test_results|activity_results|generated_quiz_attempts|recent_scans|offlineSync)(/|$)');
  select coalesce(jsonb_agg(to_jsonb(r)), '[]') into runs from public.imars_mobile_production_runs r where uid = any(student_uids);
  select coalesce(jsonb_agg(to_jsonb(r)), '[]') into receipts from public.imars_mobile_production_receipts r where uid = any(student_uids);
  select jsonb_build_object(
    'students', count(*) filter(where collection_path = 'users' and fields->'role'->>'stringValue' = 'student'
      and (coalesce(fields->'active'->>'booleanValue','true') = 'true'
        or coalesce((fields->'archivedSchoolYear'->>'integerValue')::integer,p_start_year) >= p_start_year)),
    'activeStudents', count(*) filter(where collection_path = 'users' and fields->'role'->>'stringValue' = 'student'
      and coalesce(fields->'active'->>'booleanValue','true') = 'true'
      and coalesce(fields->'status'->>'stringValue','active') not in ('inactive','disabled','deleted','archived')),
    'sections', count(*) filter(where collection_path = 'classes'),
    'quizzes', count(*) filter(where collection_path = 'generatedQuizzes'),
    'documents', jsonb_array_length(snapshot), 'mobileActivities', jsonb_array_length(runs)) into totals
    from public.imars_app_documents where dataset_id = p_dataset;
  insert into public.imars_school_year_archives(dataset_id,start_year,next_year,closed_by,counts,documents,mobile_runs,mobile_receipts)
    values(p_dataset,p_start_year,p_start_year+1,p_admin_id,totals,snapshot,runs,receipts) returning id into archive_id;

  -- All following mutations and the archive above succeed or roll back together.
  delete from public.imars_app_documents where dataset_id = p_dataset and
    (split_part(path,'/',1) in ('generatedQuizzes','generatedQuizRevisions')
      or path ~ '^users/[^/]+/(test_results|activity_results|generated_quiz_attempts|recent_scans|offlineSync)(/|$)');
  delete from public.imars_mobile_production_receipts where uid = any(student_uids);
  delete from public.imars_mobile_production_runs where uid = any(student_uids);
  update public.imars_app_documents set fields = (fields - 'gamification' - 'completedQuizzes') ||
    jsonb_build_object('active',jsonb_build_object('booleanValue',false),'status',jsonb_build_object('stringValue','archived'),
      'legacyResultsArchived',jsonb_build_object('booleanValue',true),'archivedSchoolYear',jsonb_build_object('integerValue',p_start_year::text),
      'schoolYearEpoch',jsonb_build_object('stringValue',(p_start_year+1)::text || ':' || archive_id::text),
      'archiveReason',case when fields->'active'->>'booleanValue' = 'false' and fields->'archiveReason'->>'stringValue' is not null
        then fields->'archiveReason' else jsonb_build_object('stringValue','school-year-closed') end,
      'deletedAt',case when fields->'active'->>'booleanValue' = 'false' and fields->'deletedAt'->>'timestampValue' is not null
        then fields->'deletedAt' else jsonb_build_object('timestampValue',stamp) end), update_time = stamp
    where dataset_id = p_dataset and collection_path = 'users' and fields->'role'->>'stringValue' = 'student'
      and (coalesce(fields->'active'->>'booleanValue','true') = 'true'
        or coalesce((fields->'archivedSchoolYear'->>'integerValue')::integer,p_start_year) >= p_start_year);
  update public.imars_app_documents set fields = (fields - 'activityDeadlineUtc') ||
    jsonb_build_object('isLocked',jsonb_build_object('booleanValue',true),'scheduledDate',jsonb_build_object('stringValue',''),
      'sectionSchedules',jsonb_build_object('mapValue',jsonb_build_object('fields','{}'::jsonb))), update_time = stamp
    where dataset_id = p_dataset and path ~ '^terms/term_0[1-3]/lessons/lesson_0[1-4]$';
  update public.imars_app_documents set fields = fields || jsonb_build_object(
      'startYear',jsonb_build_object('integerValue',(p_start_year+1)::text),'endYear',jsonb_build_object('integerValue',(p_start_year+2)::text),
      'updatedBy',jsonb_build_object('stringValue',p_admin_id),'updatedAt',jsonb_build_object('timestampValue',stamp),
      'lastArchiveId',jsonb_build_object('stringValue',archive_id::text),'legacyResultsArchived',jsonb_build_object('booleanValue',true)), update_time = stamp
    where dataset_id = p_dataset and path = 'webSettings/schoolYear';
  insert into public.imars_app_documents(dataset_id,path,fields,update_time) values(p_dataset,
    'webSettings/security/audit/' || lpad((9999999999999 - floor(extract(epoch from clock_timestamp()) * 1000)::bigint)::text,13,'0') || '_' || replace(archive_id::text,'-',''), jsonb_build_object(
      'actorId',jsonb_build_object('stringValue',p_admin_id),'actorRole',jsonb_build_object('stringValue','admin'),
      'action',jsonb_build_object('stringValue','school-year-closed'),'targetId',jsonb_build_object('stringValue',p_start_year::text),
      'details',jsonb_build_object('stringValue','Archived year; archived students; opened next school year'),
      'at',jsonb_build_object('stringValue',stamp)),stamp);
  update public.imars_app_datasets set revision = gen_random_uuid() where id = p_dataset;
  return jsonb_build_object('id',archive_id,'startYear',p_start_year,'nextYear',p_start_year+1,'counts',totals);
end;
$$;
revoke all on function public.imars_close_school_year(uuid,uuid,integer,text) from public,anon,authenticated;
grant execute on function public.imars_close_school_year(uuid,uuid,integer,text) to service_role;

-- Serialize mobile writes with rollover. A request authorized before the year
-- closed cannot recreate results after that student's profile is archived.
create or replace function public.imars_mobile_production_commit(
  p_uid text, p_action text, p_request_id text, p_digest text, p_activity_id text,
  p_version uuid, p_item jsonb, p_receipt jsonb
) returns jsonb language plpgsql set search_path = '' as $$
declare previous public.imars_mobile_production_receipts%rowtype; current_version uuid;
begin
  perform pg_catalog.pg_advisory_xact_lock_shared(pg_catalog.hashtextextended('imars-school-year:production',8393));
  if exists(select 1 from public.imars_school_year_archives where dataset_id = 'a176e0fd-0b7e-4840-99c5-413452160b6a'::uuid)
    and not exists(select 1 from public.imars_app_documents where dataset_id = 'a176e0fd-0b7e-4840-99c5-413452160b6a'::uuid
      and collection_path = 'users' and fields->'uid'->>'stringValue' = p_uid and fields->'role'->>'stringValue' = 'student'
      and coalesce(fields->'active'->>'booleanValue','true') = 'true'
      and coalesce(fields->'status'->>'stringValue','active') not in ('inactive','disabled','deleted','archived')) then
    raise exception 'This student is no longer active' using errcode = '42501';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_uid,8392));
  select * into previous from public.imars_mobile_production_receipts where uid=p_uid and action=p_action and request_id=p_request_id;
  if found then return jsonb_build_object('digest',previous.digest,'receipt',previous.receipt); end if;
  select version into current_version from public.imars_mobile_production_runs where uid=p_uid and activity_id=p_activity_id;
  if current_version is distinct from p_version then return null; end if;
  if p_item is not null then
    insert into public.imars_mobile_production_runs(uid,activity_id,item) values(p_uid,p_activity_id,p_item)
      on conflict(uid,activity_id) do update set item=excluded.item,version=gen_random_uuid();
  end if;
  insert into public.imars_mobile_production_receipts(uid,action,request_id,digest,receipt) values(p_uid,p_action,p_request_id,p_digest,p_receipt);
  return jsonb_build_object('digest',p_digest,'receipt',p_receipt);
end;
$$;
notify pgrst, 'reload schema';
commit;
