# Security deployment status — 2026-10-16

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
