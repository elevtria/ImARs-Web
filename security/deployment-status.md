# Security deployment status

## Current checkpoint — 2026-10-21

- Production Pages lists encrypted `FIREBASE_SERVICE_ACCOUNT_JSON`,
  `GEMINI_API_KEY`, `WEB_MAINTENANCE_KEY`, `WEB_SESSION_SECRET` and
  `WEB_STAFF_ACCOUNTS`. The real dedicated gateway credential now passes Google
  authentication, all seven required IAM permissions and read-only Firestore/Auth
  checks, including an empty transaction and rollback. The checked IAM-management
  and Auth create/update/delete permissions were absent. Replaced the example
  service-account Production secret using stdin with logging disabled; no key or
  token was displayed or copied into the repository. The user confirmed the
  staff roster contains real account details; saved roster/key settings still
  require deployment validation.
- Updated the private `imars-web-auth` Worker to version
  `5e36b647-4e90-4fec-8bc3-25e069f4789c` after 177 tests and a successful
  dry-run compilation. No public Worker target was enabled.
- The live website's public auth config still reports `enabled: false`.
  Production serves `main` (`ecabdfb`) and the old login asset
  `/assets/site-a6011748da17b6e9b095/js/login.js`, which still contains the
  Firebase client configuration. The gateway branch removes that configuration
  but has not been merged into `main` or deployed as the Production website.
- Required next: verify the saved server settings and initial staff enrollment,
  then configure and test a separate preview before activation.
  Firebase rules and mobile source were not changed by this checkpoint.
- The separate private Preview Worker `imars-web-auth-preview` is deployed at
  `aff8fe94-5f2c-4b13-be33-6911ecfcd556`; its trigger settings confirm no public
  targets. Preview uses its own state binding. Following the user's explicit
  approval, uploaded the validated service-account credential and fresh random
  session/maintenance keys as encrypted Preview secrets through stdin with logs
  disabled; their three saved names are confirmed. Preview's approved staff
  roster and Gemini key must still be supplied before redeployment and live
  staff/quiz acceptance checks. Production secrets were not changed by this step.
- Deployed `gateway-review` Preview (`41bce574`) at
  `https://gateway-review.imars-web.pages.dev`. Login HTML/module return 200;
  the served module has no Firebase configuration or private key. Setup and
  protected requests return 503 until secrets are supplied. Production's public
  config still reports the gateway disabled. A fresh comparison confirms that
  Production still serves the old login module containing Firebase config;
  Preview serves `site-c6ea6a6ad39f5cd10b41/js/login.js` without Firebase config.
- Newly invited teachers must have a verified Firebase Auth email matching the
  private invitation. Existing independently approved roster accounts keep the
  current login flow. All 178 automated tests, the public website build and
  Pages Functions compilation pass after this check.

See [the gateway setup](../docs/web-data-gateway.md) for the current rollout.

## Historical snapshot — 2026-10-16

## Completed and verified

- The owner completed Cloudflare CLI sign-in. The signed-in account contains
  the existing Git-connected `imars-web` Pages project.
- Deployed the new private `imars-web-auth` Worker from
  `wrangler.web-auth.jsonc`. Active version:
  `7e7e7907-1a5d-4b22-8a72-51581e0f13e1` (100% deployment).
- The Worker exports `WebLoginState` and has its SQLite Durable Object binding.
  `workers_dev` and `preview_urls` are false, and there are no public routes.
- Prepared the production Pages binding in the local `wrangler.jsonc`.
  Preview has no production state binding.
- Re-ran all 109 automated tests, the website build and the Pages Functions
  compilation successfully before considering a Pages deployment.

## Live website deliberately retained

The current production Pages deployment is
`74eb4c1e-17d2-4278-af87-f4c3ecfda472`, from repository commit `ba50d98`.
No Pages deployment was performed in this step, and its live binding list is
still empty. The private Worker is therefore not yet connected to the website.

The downloaded live configuration showed `WEB_LOGIN_ENABLED` and
`ACCOUNT_ACCESS_ENABLED` unset. Production currently lists only the encrypted
`GEMINI_API_KEY` secret; no secret values were displayed or changed.

The live commit is newer than local HEAD `5d4f26d`. Fetched `origin/main` without
altering working files. Its four changed files add batch-upload validation and
student-profile editing:

- `batch-upload.html`
- `js/batch-upload.js`
- `student-records.html`
- `js/student-records.js`

Those changes must be integrated with the local performance/security work before
the next Pages deployment. An ignored comparison/merge preview is saved under
`.wrangler/production-source-merge`; it has not been copied over the working
source. The student-record script has overlapping edits requiring review.

## Still required

1. Prepare a dedicated Firebase service account with the permissions described in
   `README.md`, store its JSON only as the encrypted Pages secret
   `FIREBASE_SERVICE_ACCOUNT_JSON`, and prepare the independently approved account
   manifest and protected website roster.
2. Complete the source integration above, then deploy the Pages binding/backend
   with both security activation flags still disabled. Check the deployed APIs
   and preserve the existing login behavior.
3. Complete isolated acceptance testing and build/distribute the compatible
   mobile app before the coordinated Firebase rules/account-provisioning cutover.

No Firebase rules, Authentication accounts, school records or production account
bindings were read or changed during this Cloudflare setup. The old Firebase
rules remain in force; the private Worker deployment alone does not secure
Firestore or activate website lockouts/session rotation.
