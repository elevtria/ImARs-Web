// Isolated SQL integration test. Install its temporary engine first:
// npm install --prefix .wrangler/school-year-sql-check --no-save --ignore-scripts --package-lock=false @electric-sql/pglite
// Run: node scripts/test-school-year-postgres.mjs
import fs from 'node:fs';import assert from 'node:assert/strict';import {PGlite} from '../.wrangler/school-year-sql-check/node_modules/@electric-sql/pglite/dist/index.js';import {encodeFields,decodeFields} from '../server/firestore-admin.js';
const db=new PGlite();await db.exec('create role anon;create role authenticated;create role service_role bypassrls;');
await db.exec(fs.readFileSync('security/supabase.app-data.sql','utf8'));await db.exec(fs.readFileSync('security/supabase.mobile-production.sql','utf8'));await db.exec(fs.readFileSync('security/supabase.school-years.sql','utf8'));
const dataset='a176e0fd-0b7e-4840-99c5-413452160b6a';await db.query('insert into public.imars_app_datasets(id) values ($1)',[dataset]);
const records=new Map([['users/ADMIN1',{role:'admin',uid:'admin',active:true,password:'never archive me'}],['users/T1',{role:'teacher',uid:'teacher',active:true}],['users/S1',{role:'student',uid:'student',active:true,classCode:'A',teacherId:'T1',displayName:'Test Student',password:'secret',gamification:{totalPoints:100}}],['classes/A',{teacherId:'T1',SectionName:'Hydrogen'}],['webSettings/schoolYear',{startYear:2026,endYear:2027}],['users/S1/test_results/term_01/lessons/lesson_01',{preTestScore:0,postTestScore:8,isPreTestCompleted:true,isPostTestCompleted:true,preTestTotalQuestions:5,postTestTotalQuestions:10}],['generatedQuizzes/Q1',{title:'Test Quiz',questions:[{correctIndex:1}]}],['terms/term_01/lessons/lesson_01',{title:'Test Lesson',isLocked:false,sectionSchedules:{A:{isLocked:false}},postTest:[{correctIndex:1}]}]]);
for(const [p,data] of records)await db.query('insert into public.imars_app_documents(dataset_id,path,fields,update_time) values($1,$2,$3,$4)',[dataset,p,encodeFields(data),'2026-11-20T00:00:00.000000000Z']);
await db.query("insert into public.imars_mobile_production_runs(uid,activity_id,item) values('student','food-web',$1)",[{studentId:'S1',classCode:'A',status:'completed',score:80,maximum:100}]);
const rev=(await db.query('select revision from public.imars_app_datasets where id=$1',[dataset])).rows[0].revision;
await assert.rejects(db.query('select public.imars_close_school_year($1,$2,2025,$3)',[dataset,rev,'ADMIN1']));
await db.exec("create function public.test_rollover_failure() returns trigger language plpgsql as $test$ begin if new.path = 'webSettings/schoolYear' then raise exception 'Injected failure'; end if; return new; end; $test$; create trigger test_rollover_failure before update on public.imars_app_documents for each row execute function public.test_rollover_failure();");
await assert.rejects(db.query('select public.imars_close_school_year($1,$2,2026,$3)',[dataset,rev,'ADMIN1']),/Injected failure/);
assert.equal((await db.query('select count(*) from public.imars_school_year_archives')).rows[0].count,0);
assert.equal((await db.query("select count(*) from public.imars_app_documents where path='generatedQuizzes/Q1'")).rows[0].count,1);
assert.equal((await db.query('select count(*) from public.imars_mobile_production_runs')).rows[0].count,1);
await db.exec('drop trigger test_rollover_failure on public.imars_app_documents; drop function public.test_rollover_failure();');
const result=(await db.query('select public.imars_close_school_year($1,$2,2026,$3) as result',[dataset,rev,'ADMIN1'])).rows[0].result;
assert.equal(result.startYear,2026);const rows=await db.query('select path,fields from public.imars_app_documents where dataset_id=$1',[dataset]);const data=new Map(rows.rows.map(r=>[r.path,decodeFields(r.fields)]));
assert.equal(data.get('users/S1').active,false);assert.equal(data.get('users/S1').legacyResultsArchived,true);assert.equal(data.get('users/T1').active,true);assert.equal(data.get('webSettings/schoolYear').startYear,2027);assert.equal(data.has('generatedQuizzes/Q1'),false);assert.equal(data.has('users/S1/test_results/term_01/lessons/lesson_01'),false);assert.equal(data.get('terms/term_01/lessons/lesson_01').isLocked,true);assert.equal(data.get('terms/term_01/lessons/lesson_01').postTest.length,1);
assert.equal((await db.query('select count(*) from public.imars_mobile_production_runs')).rows[0].count,0);
const archive=(await db.query('select * from public.imars_school_year_archives')).rows[0];assert.equal(archive.documents.find(d=>d.path==='users/S1').fields.password,undefined);assert.equal(archive.documents.find(d=>d.path.includes('/test_results/')).fields.preTestScore.integerValue,'0');
await assert.rejects(db.query('select public.imars_close_school_year($1,$2,2026,$3)',[dataset,rev,'ADMIN1']));
await db.exec('set role service_role');await assert.rejects(db.query("select public.imars_mobile_production_commit('student','reserve','retry','digest','food-web',null,$1,$2)",[{studentId:'S1'},{}]),/no longer active/);assert.equal((await db.query('select count(*) from public.imars_mobile_production_runs')).rows[0].count,0);await db.exec('reset role');
await db.query("insert into public.imars_app_documents(dataset_id,path,fields,update_time) values($1,'users/S2',$2,'2027-06-01T00:00:00Z')",[dataset,encodeFields({role:'student',uid:'second',active:true,classCode:'A',displayName:'New Student'})]);
const nextRevision=(await db.query('select revision from public.imars_app_datasets where id=$1',[dataset])).rows[0].revision;
await db.query('select public.imars_close_school_year($1,$2,2027,$3)',[dataset,nextRevision,'ADMIN1']);
const second=(await db.query('select * from public.imars_school_year_archives where start_year=2027')).rows[0];
assert.equal(second.counts.students,1);assert.equal(second.documents.some(row=>row.path==='users/S1'),false);assert.equal(second.documents.some(row=>row.path==='users/S2'),true);
console.log('PASS: PostgreSQL migration, year validation, atomic archive/reset, preserved teachers/curriculum/zero scores, private snapshots, retry rejection, and stale mobile-write protection.');await db.close();
