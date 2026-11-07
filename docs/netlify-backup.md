# Netlify hosting backup

Backup: [imars-web.netlify.app](https://imars-web.netlify.app).
Project: [Netlify settings](https://app.netlify.com/projects/imars-web).

This is a separate host for the same website and Firebase project. It does not
replace Cloudflare or make a copy of the database. A Firebase outage affects
both hosts.

## Create and configure the site

1. Sign in to Netlify and approve the CLI authorization request. Create a new
   site for this repository; do not replace an existing project.
2. Use `npm run build:netlify`, publish `dist`, and use `netlify/functions` for
   Functions. These settings are in `netlify.toml`. A drag-and-drop upload of
   `dist` alone does not install the backend or protect portal pages.
3. In the site's environment-variable settings, add the server-only values
   below for the production Functions and Edge Functions runtime. Do not put
   secrets in `netlify.toml`, browser JavaScript, Git, or chat. Cloudflare's
   encrypted secrets cannot be read back to copy automatically.

| Variable | Value |
| --- | --- |
| `FIREBASE_SERVICE_ACCOUNT_JSON` | The real account-gateway JSON file, with the existing Firebase IAM permissions. |
| `WEB_STAFF_ACCOUNTS` | The approved staff roster, with real school IDs, Firebase UIDs, emails and roles; use the shape in the login protection guide. |
| `WEB_SESSION_SECRET` | A new random secret, at least 32 characters. |
| `WEB_MAINTENANCE_KEY` | A separate random maintenance secret; retain it securely for account recovery. |
| `NETLIFY_BACKGROUND_SECRET` | Another independent random secret, at least 32 characters. |
| `GEMINI_API_KEY` | The existing Gemini API key, entered directly in Netlify. |
| `NETLIFY_BACKUP_ENABLED` | Keep disabled until the required secrets are configured; set `true` for activation. |

Netlify supplies `URL` as the site's canonical HTTPS origin. Background jobs
target this origin. Preview deployments do not get independent production
credentials or state automatically; configure isolated test credentials before
using authenticated previews.

Existing staff invitations live in Cloudflare's private state. Import only
approved registered staff into the backup roster. Adding or disabling accounts
in one host's private roster does not automatically synchronize that roster with
the other host; keep both rosters maintained when using the backup. Live Firebase
profile status and identities are checked by both hosts.

4. Build and deploy the whole site through Netlify CLI or its Git integration.
   Environment-variable changes require a new deployment. Run the checks below
   before announcing the backup URL. Do not upgrade the plan or enable paid
   services without the account owner's choice.

## Backend behavior

The backup reuses the existing authentication, authorization, data gateway,
student quiz API and dashboard summary logic. Private Netlify Blobs replace
Cloudflare Durable Objects for this host's sessions, lockouts, invitations and
rollups. Strong reads and conditional ETag writes protect concurrent updates;
warm dashboard requests read a compact summary rather than the full student
state. Background jobs process bounded batches and publish complete summaries.
Passive session checks do not rewrite unchanged state. Netlify's per-request
environment wrapper shares the existing short identity-status cache; profile
status and ownership checks remain live. API logs record route, status and
timings without request bodies, cookies, tokens or student details.

The scheduler batches initial section and lesson reads. A fresh browser must
choose an assigned section before editing; a valid previous choice is restored.
Complete card headings and layouts remain visible instead of generic blank
placeholder blocks. Unknown numeric values show a dash. The scheduler restores
the same authenticated teacher's last successful server response from the
existing per-tab cache, then refreshes in the background every minute while
visible. Unchanged responses do not rebuild its term cards; network failures
retain the saved schedule, while authorization failures are still rejected.
Editing waits for the live section check. The cache expires after 15 minutes
and is cleared when the account changes or signs out. No student data is loaded
before authentication. Explicitly hidden tabs and dialogs remain hidden.

Quiz PDFs keep the 50 MB application limit. The backup uploads them in 3 MB
chunks and runs generation in a background Function, then opens the existing
review editor. Uploaded chunks are private and removed after processing or
expiry. No R2 bucket or Firebase billing change is required. Netlify usage and
Gemini quotas still apply.

Cookies, password lockouts and local mobile receipt storage belong to each host.
Users sign in again on the backup. Teacher platform ownership is shared through
the private Firestore session record: a successful teacher login on Netlify also
revokes the mobile receipt checked through Cloudflare, and mobile login ends
the teacher's web sessions on either host. See the login protection guide.
The installed mobile app still targets the Cloudflare API URL; mobile API
failover needs a compatible origin configuration and a rebuilt app.

## Release checks

- Run `npm test`, `npm run build`, and `netlify build --offline`.
- Confirm logged-out dashboard/admin paths redirect to login, protected APIs
  deny access, and student APIs use student token authentication.
- Sign in with an approved administrator and teacher. Check role restrictions,
  sections, student records, analytics and schedules without changing records
  unnecessarily. Check lockouts with an approved test account.
- Verify a warm dashboard returns its summary and background changes appear.
- Generate a quiz from a small document and a multi-chunk PDF; verify review,
  saving and reopening. Confirm another teacher cannot read the temporary job.
- Confirm no service-account data, private keys or server source appear in the
  published assets. Verify Cloudflare remains healthy.

## Failover

Keep the verified Netlify URL bookmarked. During a Cloudflare-only outage, open
that URL and sign in normally. Existing Firebase records remain shared; this is
not a database restore. Switching a custom domain's DNS is a separate operation
and is not part of creating this backup.

## Publish later changes

This site is linked to the local checkout through ignored `.netlify/state.json`.
It was deployed with the CLI; pushing to Git does not automatically update this
backup unless a separate Netlify Git integration is configured. To publish the
current checkout to this backup explicitly:

```powershell
npm exec --yes --package=netlify-cli@27.16.2 -- netlify deploy --prod --build --site 96641800-a9b3-4827-a45b-b570c5b38a74
```

Keep Netlify and Cloudflare deployment commands separate. The regular
`npm run build` keeps Cloudflare's existing quiz upload endpoint; Netlify's
build adds the capability marker for its chunked quiz transport.

Platform references:
[Netlify Functions limits](https://docs.netlify.com/build/functions/configuration/),
[private Blobs and conditional writes](https://docs.netlify.com/build/data-and-storage/netlify-blobs/),
[runtime environment variables](https://docs.netlify.com/build/edge-functions/environment-variables/).
