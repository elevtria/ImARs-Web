# Website data gateway

Prepared and tested locally on 2026-10-21 on `codex/cloudflare-data-gateway`.
Production remains on its existing deployment. This branch requires the server
setup below before deployment; it deliberately has no direct browser fallback.

Cloudflare status checked on 2026-10-21: all five Production secret names are
present. The dedicated `imars-account-gateway` credential has now passed Google
authentication and `testIamPermissions` for all seven required permissions.
The checked IAM-management and Auth create/update/delete permissions were absent.
Live Firestore reads, a query with a nonexistent probe UID, Auth lookup of that
probe UID and an empty transaction followed by rollback passed without changing
records. Replaced the example `FIREBASE_SERVICE_ACCOUNT_JSON` Production secret
with that validated credential through stdin, with logging disabled. No key or
token was printed or copied into the repository. The user confirmed that
`WEB_STAFF_ACCOUNTS` contains real staff details; its saved contents and the other
secrets still require deployment checks. The private `imars-web-auth` Worker was updated to version
`5e36b647-4e90-4fec-8bc3-25e069f4789c`; all 177 automated tests and its dry-run
build passed beforehand. The live website still serves `main` (`ecabdfb`) with
the older Firebase browser configuration, and both activation flags remain off.
The isolated private Preview Worker `imars-web-auth-preview` is deployed at
version `aff8fe94-5f2c-4b13-be33-6911ecfcd556`, with no public targets. Preview
configuration now binds to that separate state Worker and enables the gateway
only within Preview; missing secrets cause setup errors instead of a fallback.
The user explicitly authorized credential use in Preview. Uploaded the validated
service-account key and fresh random `WEB_SESSION_SECRET` and
`WEB_MAINTENANCE_KEY` to encrypted Preview secrets through stdin with logging
disabled; their saved names are confirmed. Preview still needs
`WEB_STAFF_ACCOUNTS` and `GEMINI_API_KEY` supplied from the real approved values.
Production's encrypted values cannot be read back for copying. Redeploy Preview
after all secrets are present, then validate staff login and quiz generation.
Deployed the website preview to `https://gateway-review.imars-web.pages.dev`
(deployment `41bce574`). Its login page and browser login module return 200 and
contain no Firebase configuration or private key. Auth configuration, protected
dashboard and data requests return 503 while setup is incomplete. Rechecked both
public login modules: Production still serves `site-a6011748da17b6e9b095`, with
Firebase configuration, and Preview serves `site-c6ea6a6ad39f5cd10b41`, without
it. Production's public auth configuration still reports both gateway flags
disabled. Saving the Preview secrets does not update the Production browser code.
The new invitation verification check passes all 178 automated tests; the
website build and Pages Functions compilation also pass.
The next checks are the saved server settings, reviewed staff identities and a
fully configured preview. Saving secrets or updating the
private Worker does not deploy the gateway branch's browser files.

## What changes

The existing browser auth/data wrappers now call authenticated Cloudflare APIs.
The website's published JavaScript contains no Firebase configuration, Firebase
API key, Google project identifier or Firebase SDK imports. The build rejects
these references and recognizable private credentials, including in public text
assets. JavaScript, HTML and CSS remain inspectable and minified.

Teacher ID/password and admin ID/email/password sign-in remain. Passwords travel
over HTTPS to the same-origin login endpoint and are verified server-side. No
Firebase ID/refresh token is returned to browser JavaScript. Website sessions use
Secure, HttpOnly, SameSite=Strict, signed cookies, the existing server lockout,
15-minute rotation/idle deadlines and 12-hour absolute limit. A UID, role and
random tab marker in session storage control fresh-visit UI behavior; they are
not login credentials. Browser owners can still inspect their own cookies and
authorized responses in DevTools.

The server checks live profile role/active state and verifies the registered
Firebase Auth identity (Auth disabled/email checks cached for at most 60 seconds).
Teachers can read/edit students in their assigned classes, their own quizzes,
scan history and marker progress. Administrators retain school reports, teacher
management, school-year selection and their own profile edits. Saves validate
allowed fields and use Firestore transactions with version preconditions.
Arbitrary paths, UID/role changes and cross-class edits are rejected.

Concurrent report reads share a request and ownership checks; the existing read
pool and view cache remain. Visible schedule/school-year/progress subscriptions
refresh at most every 15 seconds and immediately after saves or returning to the
tab. Hidden tabs stop polling. This replaces Firebase push listeners, so a change
from another browser can appear up to 15 seconds later. Polls do not extend idle
sessions. Confirmed writes invalidate cached views; failed writes do not.

Quizzes retain the existing 50 MB PDF/DOCX/PPTX flow, review, editing and saving.
The AI secret stays server-side. Student imports check only submitted IDs instead
of downloading every school's student profiles. QR sync retains an existing
student's assigned class. Admin invitations receive a server-allocated Teacher
ID and private approval marker; existing mobile registration's merge/update
preserves that marker. Newly registered teachers must verify the privately
assigned email in Firebase Auth before website access is granted; possession of
the public invitation marker alone cannot activate an account. Verification is
checked again on a fresh login so an earlier unverified lookup does not delay
activation. Independently approved initial staff retain their existing UID-bound
login. No manual roster secret edit is needed for verified invitations. IDs are
never reused after a deletion or failed reservation. Contact emails remain
separate from the private approved sign-in email.

## Owner setup before activation

1. Have the Google Cloud project owner grant the dedicated service account the
   reviewed permissions in [the IAM setup](../security/iam/README.md). An Editor
   account cannot create/grant that custom role by itself. The gateway needs
   document deletion and transaction permissions in addition to the earlier
   account-activation permissions. Do not grant Owner or Editor to the service
   account.
2. Save the dedicated account JSON only as the encrypted Pages secret
   `FIREBASE_SERVICE_ACCOUNT_JSON`. Never send it through chat or put it in a
   public asset, Git, a build variable or Unity resources.
3. Configure encrypted `WEB_SESSION_SECRET`, `WEB_MAINTENANCE_KEY` and
   `WEB_STAFF_ACCOUNTS` using the existing [login setup](web-login-protection.md).
   Independently verify initial staff IDs, Auth UIDs, registered emails and roles
   against Firebase Authentication and the school roster. Do not blindly trust
   profiles from a database whose rules are still public. Keep the existing
   encrypted `GEMINI_API_KEY`.
4. Deploy the updated private `imars-web-auth` Worker before deploying this
   branch. It adds private invitation/ID allocation actions. Confirm the Pages
   `WEB_LOGIN_STATE` binding points to that Worker in the same account. Preview
   uses `imars-web-auth-preview`, separate state, separate secrets and reviewed
   test accounts.
5. Test a configured preview with approved test accounts, including login,
   dashboard, reports, class creation/import, edits, QR result saves, schedules,
   marker progress, quizzes, admin invitations/unlock and session expiry.
   Completed local browser checks used only synthetic records. No production
   private key or real student records were used in those local checks.
6. Set `WEB_LOGIN_ENABLED=true` and `WEB_DATA_ENABLED=true` for the deployment
   that serves this branch, then perform the production cutover only after those
   prerequisites pass. Deploying the new browser files before setup will block
   sign-in. Disabling flags does not restore the removed browser connections;
   rollback requires redeploying the previous working website version. Keep
   private Worker state in place during rollback.

Creating secrets does not change Firebase rules or mobile behavior. This website
branch does not edit mobile source, distribute an APK or implement mobile-triggered
web logout. The previously shared open Firestore rules still allow direct access
independently of the website. Hiding configuration does not fix those rules;
the coordinated mobile/rules rollout in [the security plan](../security/README.md)
remains necessary. Do not publish stricter rules ahead of compatible mobile apps.

## Local verification

```powershell
npm.cmd test
npm.cmd run test:rules
npm.cmd run build
npx.cmd --no-install wrangler pages functions build functions --outdir .wrangler/gateway-functions
```

The temporary manual preview servers have been removed after the browser checks.
The synthetic fixtures used by automated tests remain. Tests/fixtures, server
sources, setup documents and credentials are excluded from public `dist`.

The emulator verifies actual REST transaction reads, transforms, commits and
rollback against `demo-imars-security-review` on loopback only. The unit suite
covers login/lockout, session privacy, data ownership/field validation, atomic
saves, private invitation enrollment, quiz authorization, batching, subscriptions,
minification and public-artifact credential/configuration rejection. Local tests
do not establish that production IAM, secrets, Firebase API restrictions or a
mobile rollout have been completed.

References: [Firebase API-key security](https://firebase.google.com/docs/projects/api-keys),
[Firestore server IAM](https://docs.cloud.google.com/firestore/native/docs/security/iam).
