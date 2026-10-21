# Local validation record — 2026-10-16

Scope: the prepared Firestore security migration and compatible mobile auth
changes. No production rules, credentials, accounts or student records were used
or changed during these local checks. No APK was built or distributed. The later
private Cloudflare Worker deployment is recorded separately in
`deployment-status.md`; the Firebase migration is not active.

## Completed checks

| Check | Result |
| --- | --- |
| `npm test` | 109 tests passed, including the existing website tests and new account-gateway/bootstrap tests. |
| `npm run test:rules` | 13 emulator scenarios passed using synthetic accounts and records. |
| `npm run build` | Website build passed: 14 pages, 117 public files, 44 versioned assets. |
| `wrangler pages functions build` | Pages Functions compiled locally. |
| Unity managed-code compilation | All 155 inspected runtime C# source files compiled against the installed Unity 2022.3.62f3/Firebase SDK with Editor and Android defines. Existing compiler warnings remain. |

The rules tests use only `127.0.0.1:58087` and the demo project
`demo-imars-security-review`. The gateway tests mock Authentication responses;
activation and bootstrap scenarios exercise the real Firestore emulator REST
commit format and document-version preconditions. No real Firebase login or
Cloudflare service-account IAM request was tested.

Covered operations include actual UID/class/report query constraints, student
avatars and achievements, lesson/fact reads, lesson schedules, pre/post results,
per-device reading/AR time transactions, teacher imports and QR results, scan
history, marker-download progress, admin management, school year and quiz-library
ownership. Denial cases include anonymous access, unprovisioned users, cross-user
writes, forged identity/roles, student schedule edits and client-written private
bindings. The server tests cover verified invitation claims, account-binding
conflicts, duplicate UIDs, disabled accounts, upstream errors and no secret-token
disclosure.

## Required before production activation

- Build and exercise the updated APK and website with a matching isolated backend,
  including real verification emails, student/teacher/admin sign-in, first avatar,
  quiz completion, offline restart and reconnection/QR sync.
- Independently approve existing account UIDs, roles and Auth emails; use the
  bootstrap tool's read-only check before its explicit write mode.
- Verify the service account's least-privilege permissions, Cloudflare secrets,
  private Durable Object binding and protected web-login roster.
- Complete the coordinated maintenance/cutover steps in `README.md`. Older APKs
  cannot use their public pre-login profile lookups under the strict candidate.

Compilation and emulator checks establish the tested code/rule behavior. They do
not prove every phone screen, production data shape, email-delivery path or live
IAM configuration works. The candidate retains teacher school-wide student reads
and offline grading; it does not claim class-only teacher visibility or protection
against tampered offline scores.
