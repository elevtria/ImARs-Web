# School Year & History

The admin page has **Current school year** and **Archived years** tabs. The top school-year selector opens this workflow; it cannot directly rename the current year.

## Database installation

Run `security/supabase.school-years.sql` once in the existing Supabase project's SQL Editor. Installation creates `imars_school_year_archives`, a protected archive/reset function, and a rollover guard for production mobile activity writes. Installation alone does not archive students, delete results, change the current year, or send email.

The archive table is private: browser/mobile roles have no access. Only the backend service role reads it. The backend checks the current administrator before listing history, producing a report, or requesting rollover. Snapshot contents are never returned directly by the API. Reports omit credentials, authentication identifiers, answer keys, and other private fields.

## Closing a year

1. Finish any outstanding grading. Archived reports are read-only; this page does not reopen a closed year.
2. Refresh the preview in Current school year.
3. Review the school year and affected counts.
4. Select Review and close school year, enter the exact `CLOSE YYYY-YYYY` phrase, and confirm the administrator password.
5. The database checks the preview revision, active administrator, current year, and unique archive. It saves the academic snapshot, archives students, clears current results/generated quizzes/mobile attempts, locks lesson schedules, and advances the year in one transaction. Teacher accounts, section assignments and lesson content remain.
6. Import the new student roster. Previous students remain archived, and old results stay in the saved year. Restoring or reenrolling an old account does not restore its old scores.

If the revision changed, refresh and review again. If a request times out, check Archived years before retrying: a timeout alone cannot establish whether the database committed. The old year/revision checks prevent an identical request from closing the following year accidentally.

Each closed year has CSV and detailed JSON report downloads. These contain roster entries, raw lesson scores, generated-quiz scores, production AR activity results, and recorded AR/module time. Missing results are blank. CSV cells are escaped against spreadsheet formula execution. Storage grows by one academic snapshot per year; normal page loads fetch metadata, not full snapshots.

## Mobile project handoff

The current Firebase Auth sign-in flow stays. Archived students are denied by the existing active-account checks. The server changes `scope.datasetEpoch` for an account that passes through a year closure, preventing old activity receipts from matching a new-year scope.

For `POST /api/mobile/v1/lesson-progress`, send `expectedDatasetEpoch` with the exact `scope.datasetEpoch` most recently returned by `me`/`progress`. This field remains optional for existing first-year accounts, but is required when a previously archived account is reenrolled. On `SCOPE_CHANGED`, refresh the account and discard/quarantine pending records from the old epoch; do not relabel old records as new-year work. No APK is built in this web project.

Legacy Firestore lesson results are excluded for accounts archived at rollover. Legacy activity compatibility reads stop after the first annual closure, so previous-year data cannot reappear in a fresh-year web report.

## Validation

Run the regular school-year/admin/mobile tests with Node's test runner. For an isolated PostgreSQL integration test:

```powershell
npm.cmd install --prefix .wrangler/school-year-sql-check --no-save --ignore-scripts --package-lock=false @electric-sql/pglite
node scripts/test-school-year-postgres.mjs
```

The PostgreSQL test creates an in-memory database, installs the migrations, and verifies a successful closure, injected mid-transaction rollback, preserved zero scores and curriculum, private snapshots, duplicate rejection, blocked stale mobile writes, and separate cohorts in consecutive archived years. It does not connect to Supabase.
