begin;

create table if not exists public.imars_mobile_production_runs (
  uid text not null,
  activity_id text not null,
  version uuid not null default gen_random_uuid(),
  item jsonb not null,
  section_id text generated always as (item ->> 'classCode') stored,
  student_id text generated always as (item ->> 'studentId') stored,
  term_id text generated always as (item ->> 'termId') stored,
  status text generated always as (item ->> 'status') stored,
  updated_at_utc text generated always as (item ->> 'updatedAtUtc') stored,
  run_id text generated always as (item ->> 'runId') stored,
  primary key (uid, activity_id)
);

create index if not exists imars_mobile_production_report
  on public.imars_mobile_production_runs (section_id, updated_at_utc desc, run_id desc)
  where status = 'completed';
create index if not exists imars_mobile_production_student_report
  on public.imars_mobile_production_runs (section_id, student_id, updated_at_utc desc, run_id desc)
  where status = 'completed';

create table if not exists public.imars_mobile_production_receipts (
  uid text not null,
  action text not null,
  request_id text not null,
  digest text not null,
  receipt jsonb not null,
  primary key (uid, action, request_id)
);

alter table public.imars_mobile_production_runs enable row level security;
alter table public.imars_mobile_production_receipts enable row level security;
revoke all on public.imars_mobile_production_runs, public.imars_mobile_production_receipts from public, anon, authenticated, service_role;
grant select, insert, update on public.imars_mobile_production_runs to service_role;
grant select, insert on public.imars_mobile_production_receipts to service_role;

create or replace function public.imars_mobile_production_commit(
  p_uid text, p_action text, p_request_id text, p_digest text, p_activity_id text,
  p_version uuid, p_item jsonb, p_receipt jsonb
) returns jsonb language plpgsql set search_path = '' as $$
declare
  previous public.imars_mobile_production_receipts%rowtype;
  current_version uuid;
begin
  -- Serializes writes for one account, including two activities using the same key.
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_uid, 8392));
  select * into previous from public.imars_mobile_production_receipts
    where uid = p_uid and action = p_action and request_id = p_request_id;
  if found then
    return jsonb_build_object('digest', previous.digest, 'receipt', previous.receipt);
  end if;

  select version into current_version from public.imars_mobile_production_runs
    where uid = p_uid and activity_id = p_activity_id;
  if current_version is distinct from p_version then
    return null;
  end if;

  if p_item is not null then
    insert into public.imars_mobile_production_runs (uid, activity_id, item)
      values (p_uid, p_activity_id, p_item)
      on conflict (uid, activity_id) do update set item = excluded.item, version = gen_random_uuid();
  end if;
  insert into public.imars_mobile_production_receipts (uid, action, request_id, digest, receipt)
    values (p_uid, p_action, p_request_id, p_digest, p_receipt);
  return jsonb_build_object('digest', p_digest, 'receipt', p_receipt);
end;
$$;

revoke all on function public.imars_mobile_production_commit(text, text, text, text, text, uuid, jsonb, jsonb) from public, anon, authenticated;
grant execute on function public.imars_mobile_production_commit(text, text, text, text, text, uuid, jsonb, jsonb) to service_role;

commit;
