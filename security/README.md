# Firebase security migration — prepared locally, not activated

Do not paste `firestore.candidate.rules` into the live console yet. Closing the
current public rule requires the matching server setup, reviewed account
bindings and updated mobile app. The private state Worker was deployed on
2026-10-16; Pages activation, account provisioning and the mobile release remain
pending. `deployment-status.md` is a historical 2026-10-16 snapshot, not current
production status. The newer website-only gateway is documented in
[its activation guide](../docs/web-data-gateway.md); its branch is not deployed.

## What was prepared

- A restrictive rules candidate covering the website and inspected Unity app.
- A server-only account gateway in `server/account-access.js`, exposed by the
  Pages Function `/api/account-access/{action}`. It is disabled unless
  `ACCOUNT_ACCESS_ENABLED` is exactly `true`.
- Local Unity changes to `LogIn.cs`, `Student_CreAcc.cs`, `Admin_CreAccount.cs`,
  plus `ImarsAccountGateway.cs`. The reviewable source diff is
  `mobile/compatible-login.patch`. No scenes, lesson, quiz, AR or progress code
  was edited. These changes have not been built into or distributed as an APK.
- A read-only-by-default bootstrap tool for existing account bindings, and
  isolated Firebase emulator tests with synthetic users.

## How the existing functions are preserved

School ID/password login is retained. In protected mode, the server checks the
password before returning the Firebase login email. The mobile Firebase SDK then
signs in normally; no new session token is stored in PlayerPrefs. Online session
restore verifies the account binding. Existing offline/weak-connection cache
paths remain available; the server controls later online reads and writes.

New registrations use the ID, assigned email, name and password. The mobile app
checks the invitation without downloading a profile, creates the Firebase Auth
account, sends verification, signs out, and returns to login. On verified sign-in,
the server atomically links that UID to the unused invitation. The previous public
student-email autofill becomes entry of the teacher-assigned email. This is the
necessary visible registration change approved in chat. Existing account holders
do not register again. Placeholder `@imars.edu` addresses need real mailboxes
before email verification can work; never activate accounts by guessing addresses.

The new private collection `_accountAccess/{authUid}` holds `profileId`, `role`,
`authEmail` and `active`. Clients cannot read/write it. Its `active` field is a
maintenance approval switch, separate from the existing teacher profile's
`active`/`status` control, which the rules and gateway also honor. Student and
teacher roles cannot be granted by editing a browser variable or a public profile.
The mapping's login email is the actual Firebase Auth email, so a contact-email
edit in an admin profile does not silently change the authentication address.

The inspected student profile, avatars, class-code acknowledgement, achievements,
term/lesson reads, pre/post tests, AR/reading time and queued result transactions
remain supported. Teacher imports, class edits, QR result transfer, recent scans,
marker download progress, topic schedules, quiz libraries, admin reports and
school-year selection are covered by the candidate and tests.

Teachers retain school-wide student **reads**, because the current mobile reports
and website ID allocation actually query all students. Writes are limited to
their assigned students/classes. This retains the inspected reporting behavior;
reducing teachers to class-only reads would require a separate report/allocation
change. Administrative users can manage the school-wide records.

## Boundaries and intentional denials

- Anonymous full-profile reads and client-written UID/role bindings are removed.
- Students cannot read/write another student's profile or results. Teachers cannot
  take over a different teacher's class or student record.
- Students cannot edit lesson questions, schedules, staff profiles or school year.
- The mobile quiz currently reads questions/answers in lesson documents and grades
  offline. Those authorized lesson reads remain supported. This migration does
  not conceal content already delivered to a student or certify offline scores
  against device tampering. That requires a separate assessment design.
- The inspected Unity app does not read `generatedQuizzes`; those documents include
  correct answers and remain staff-only. Do not enable student access without a
  separate student-facing quiz representation and corresponding client changes.
- Browser developer tools can still show public Firebase configuration, API URLs,
  the current user's authorized responses and their own tokens/cookies. The
  service-account private key is never included in browser or mobile assets.

## Server prerequisites, first in a separate test environment

1. Use an isolated Firebase/Cloudflare environment for acceptance testing. This
   requires a dedicated test build with matching Firebase configuration in both
   the server and Unity app, plus a test gateway URL. The supplied production
   source is pinned to the existing project ID and website URL; changing only
   the service-account secret will not switch projects. The local emulator tests
   override only their test adapter. Do not point a Cloudflare Preview deployment
   at production student records for testing.
2. Configure the existing private `WEB_LOGIN_STATE` Durable Object binding for
   request throttling; see `docs/web-login-protection.md` for the Worker setup.
   The production binding is prepared in `wrangler.jsonc`, so dashboard editing
   is disabled. Deploy the separate state Worker before the next production
   Pages deployment. Preview intentionally has no production state binding.
3. Create a dedicated service account for Firestore document read/create/update
   and Firebase Auth user lookup (`firebaseauth.users.get`). Have the project
   administrator check least-privilege IAM permissions. Do not give it Owner or
   Editor just to make a request pass.
   `iam/README.md` explains the dedicated identity and the five-permission custom
   role prepared in `iam/account-gateway-role.json`, including the required query
   permission and the limits of project-level IAM.
4. Store its JSON only as an encrypted Cloudflare secret named
   `FIREBASE_SERVICE_ACCOUNT_JSON`. Do not put it in HTML, browser environment
   variables, Unity resources, Git, screenshots or chat. The local bootstrap tool
   accepts the same secret via a process environment variable.
5. Deploy the backend with `ACCOUNT_ACCESS_ENABLED` unset/false first. The updated
   app continues the original flow while the config endpoint reports false.
   Network/configuration errors are not treated as permission to bypass a known
   enabled gateway. No broad Firebase rule is added as a fallback.
6. For the website, configure and test `WEB_LOGIN_ENABLED=true`, the signed web
   session keys, private binding, and `WEB_STAFF_ACCOUNTS`. The new website
   gateway also requires `WEB_DATA_ENABLED=true` and the dedicated service
   account. Initial staff need approved roster entries; gateway-created teacher
   invitations carry private approval through mobile registration.

## Review existing identities without writing records

Prepare a manifest using actual Firebase Authentication UIDs/emails and the school
roster. `account-manifest.example.json` contains dummy values only. Keep the real
file in `.wrangler/access-manifest.json` or another private, untracked location.
Include every registered teacher, admin and student who needs access, retain an
active administrator, and exclude unused invitations (they have no UID yet).

The current database was publicly writable, so do not blindly trust every existing
profile's role/UID/email. Independently confirm staff membership and student roster
associations. Authentication email lookup confirms identity, not school approval.

With the service-account JSON supplied through the local process environment:

```powershell
node scripts/bootstrap-account-access.mjs .wrangler/access-manifest.json
```

Without `--apply`, this only checks that each reviewed profile and Authentication
account matches. It rejects duplicate UIDs/IDs/emails, wrong roles, disabled Auth
accounts marked active, missing administrators and conflicting existing bindings.
No key, token, email or individual profile is printed.

## Coordinated production cutover — owner action still required

First run acceptance tests on the prepared app and a matching isolated backend,
including registration/verification, both web roles, quiz saves, offline play and
reconnection/QR sync. Managed-code compilation and emulator tests are not a test
of every screen on a real phone.

After those checks, schedule a short maintenance window and ensure the updated
APK is ready for the users. Older APKs use public pre-login profile reads and
will need updating before they can sign in under the new rules.

During that reviewed window:

1. Retain the original rules and back up current data through the project owner's
   approved process. Freeze roster edits while checking/creating the bindings.
2. Publish the tested restrictive rules. Keep the gateway disabled until the old
   public wildcard rule is gone: it would otherwise allow attackers to modify even
   the new private bindings. Never add the old wildcard alongside these rules.
3. Create the reviewed existing-account bindings explicitly:

   ```powershell
   node scripts/bootstrap-account-access.mjs .wrangler/access-manifest.json --apply
   ```

   Each create is paired atomically with a check of its profile's exact version.
   The tool does not change any user profile, password, Authentication user, quiz
   or result. Completed batches can be checked/retried without replacing bindings.
4. Enable `ACCOUNT_ACCESS_ENABLED=true` and the tested website session settings,
   then redeploy Pages so both configurations take effect. Start/restart the
   updated mobile app. Verify the config endpoint returns JSON with `enabled:true`.
5. Check real authorized test accounts and the agreed functions before ending the
   maintenance window. Keep a recovery administrator available.

There is intentionally no automatic production deployment or rules publication.
If a check fails, keep maintenance in place and diagnose the denied operation.
The retained original rule is an insecure emergency recovery option, not a
permanent rollback target or an automatic retry strategy.

## Local validation

```powershell
npm ci
npm test
npm run test:rules
npm run build
```

`test:rules` needs Java 21+; it can use the portable runtime prepared under the
ignored `.wrangler/firestore-security-runtime/java` directory. It starts only the
Firestore emulator for `demo-imars-security-review`. Tests reject any emulator
host other than `127.0.0.1:58087`. They use synthetic records and mocked Auth
responses; no real Firebase credentials are needed. If a local port is occupied,
stop only your own test process or choose/update the dedicated fixture ports.

See `validation.md` for the completed local checks and their limits.

References: [Firebase rules and queries](https://firebase.google.com/docs/firestore/security/rules-query),
[Firebase rules testing](https://firebase.google.com/docs/rules/unit-tests),
[Unity user verification](https://firebase.google.com/docs/auth/unity/manage-users),
[Firestore atomic commits](https://cloud.google.com/firestore/docs/reference/rest/v1/projects.databases.documents/commit),
and [administrative Authentication lookup](https://cloud.google.com/identity-platform/docs/reference/rest/v1/projects.accounts/lookup).
