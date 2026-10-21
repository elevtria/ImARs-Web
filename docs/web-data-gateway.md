# Website data gateway

Prepared and tested locally on 2026-10-21 on `codex/cloudflare-data-gateway`.
Production remains on its existing deployment. This branch requires the server
setup below before deployment; it deliberately has no direct browser fallback.

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
preserves that marker. Newly registered teachers do not need a manual roster
secret edit when created through this gateway. IDs are never reused after a
deletion or failed reservation. Contact emails remain separate from the private
approved sign-in email.

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
   requires a separate test Worker, separate state and reviewed test accounts;
   the repository intentionally leaves its binding empty.
5. Test a configured preview with approved test accounts, including login,
   dashboard, reports, class creation/import, edits, QR result saves, schedules,
   marker progress, quizzes, admin invitations/unlock and session expiry.
   The local fixture below uses only synthetic records. No production private
   key or real student records were used in the completed local checks.
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

Browser fixture, after building:

```powershell
node tests/web-data.local.mjs
```

Open `http://127.0.0.1:8848/login`. Synthetic accounts are `TEACH1000` and
`ADMIN1000`, password `correct`. This fixture is not a deployment target and
must never be hosted or connected to production credentials. Tests/fixtures,
server sources, setup documents and credentials are excluded from public `dist`.

The emulator verifies actual REST transaction reads, transforms, commits and
rollback against `demo-imars-security-review` on loopback only. The unit suite
covers login/lockout, session privacy, data ownership/field validation, atomic
saves, private invitation enrollment, quiz authorization, batching, subscriptions,
minification and public-artifact credential/configuration rejection. Local tests
do not establish that production IAM, secrets, Firebase API restrictions or a
mobile rollout have been completed.

References: [Firebase API-key security](https://firebase.google.com/docs/projects/api-keys),
[Firestore server IAM](https://docs.cloud.google.com/firestore/native/docs/security/iam).
