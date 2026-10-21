# Website data gateway

Activated on Production on 2026-10-21 at https://imars-web.pages.dev.
The verified release is 8e5c025, initially deployed as c15c95fb. The live browser
asset version is site-d6ac71af8620e21ac612. Both gateway activation flags are true.
The private Production state Worker remains imars-web-auth, version
5e36b647-4e90-4fec-8bc3-25e069f4789c, with no public Worker route.

All 182 automated tests, the website build and Pages Functions compilation pass.
Live checks confirm login HTML/module and school-year requests return 200,
anonymous dashboard requests redirect to login, and anonymous data requests and
unknown-account login probes return 401. The served login module contains no
Firebase configuration or private key. No real staff password was used during
deployment checks; staff sign-in and AI generation still need normal user acceptance.

All five encrypted Production settings are present. The dedicated service-account
credential passed Google authentication, all seven required IAM permissions,
Firestore reads/query, Auth lookup and an empty transaction/rollback. The checked
IAM-management and Auth create/update/delete permissions were absent. The user
confirmed the initial roster contains real approved accounts. No credential or
token was printed or copied into the repository.

An initial release attempt was restored to the previous working build after a
Cloudflare-native fetch receiver error. A regression reproduces the problem;
the fixed request wrapper passed the real Preview database check and the
subsequent Production checks. No database records were changed by these probes.

The latest main-branch QR route, scanner library and reconnect work through
630a2f1 are included. Pending QR results are stored by teacher UID and retried
after reconnect and authenticated sign-in. History uses the same pending-scan ID
on retries. The service worker caches versioned public assets only; protected
HTML and API responses never use its offline cache.

Preview uses the separate private imars-web-auth-preview Worker, version
aff8fe94-5f2c-4b13-be33-6911ecfcd556. With explicit user approval, its gateway
credential and fresh session/maintenance keys were saved as encrypted secrets.
Its public school-year request passes. Preview still lacks WEB_STAFF_ACCOUNTS
and GEMINI_API_KEY, so further Preview staff/quiz acceptance checks require those
settings. Production uses its existing complete settings.

Firebase rules, mobile source and Firebase Authentication accounts were not
changed by this website release. The separate coordinated mobile/rules rollout
is still required to replace the previously shared public Firestore rules.

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
