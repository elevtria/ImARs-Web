# Website login protection

Prepared locally with the [website data gateway](web-data-gateway.md). Production
activation still requires the private binding, dedicated Firebase service-account
secret, session keys and reviewed staff roster. This branch fails closed until
that setup is complete. Firebase rules and mobile code are unchanged; public
Firestore rules remain a separate data-access risk.

## Account policy

Both teacher and administrator website accounts use the same policy:

| Failed password attempts | Web restriction |
| --- | --- |
| First set of 3 | 5 minutes |
| Second set of 3 after waiting | 5 hours |
| Third set of 3 after waiting | Indefinite; authorized manual unlock required |

A verified successful login resets the failure history. Attempts during a lock
do not extend it. Network errors, upstream throttling, disabled Firebase accounts,
and configuration errors do not count as wrong passwords. Time passing never
clears an indefinite lock. Teachers contact an administrator or maintenance;
locked administrators require maintenance recovery.

## Enforcement and limits

Cloudflare Durable Objects persist counters by Firebase UID and serialize the
password check and state change. Admin email and school-ID aliases share a
counter. Browser-supplied counts, timestamps, roles, or unlock flags are ignored.
The Worker exposes no public endpoint; Pages reaches it through a binding.

After verifying the password with Firebase, the website issues a signed,
host-bound, Secure/HttpOnly session cookie. Pages middleware checks this cookie
and the current server lock/version before serving portal pages or APIs. Old
cookies stop working when a lock or unlock changes the version. Editing JavaScript
or directly signing into Firebase does not mint a website cookie. Sign-out revokes
the account's existing web sessions.

### Session renewal and expiry

Both portals require a fresh website login for a new visit. The browser uses
the signed Cloudflare session instead of Firebase browser authentication. The
login page clears the old visit marker; a direct URL, bookmark, new tab or
restored history entry returns to login. Navigation inside the website and reloads during the same visit keep sign-in.
Browser restoration behavior varies, so the website also checks the navigation
entry and its per-tab visit marker instead of relying on closing events alone.

The marker contains only the UID, portal role, start time and random tab ID, and
expires after 12 hours. The tab ID must match this browsing context's window name,
so a new tab inheriting its opener's session storage cannot reuse the login.
These are UI lifecycle markers, not database or server credentials. Page
data callbacks wait for a server-verified staff identity with its approved UID,
role and live profile active status. An unavailable check
does not fall back to cached student records. Logout clears this tab's saved
views, notifies other website tabs for that UID, and hides history pages before
they can be restored. Portal HTML uses `private, no-store`; existing immutable
static-asset caching stays in place. Protected pages start hidden until the
shared check succeeds. All of this reuses the existing auth, CSS and cache files.

These website checks do not prevent direct Firestore calls while database rules
are public. They do not implement mobile-triggered website logout; that needs an
authenticated mobile session signal and compatible mobile rollout. Neither the
mobile source nor Firebase rules is changed by this website visit update.

When protection is enabled, both portals use these server-enforced limits:

- The signed HttpOnly cookie renews after 15 minutes on the next session check or
  protected request. Renewal happens quietly without clearing forms or reloading.
- A previous credential has a 30-second allowance for overlapping requests. It
  cannot obtain a replacement cookie or extend inactivity. After that allowance,
  the server rejects it even if its signature and original expiry are still valid.
- Inactivity ends the session after 15 minutes. Visible input activity sends an
  update, coalesced to avoid requests on every mouse movement. Passive background
  checks and merely focusing a tab do not extend the deadline. A warning appears
  during the last minute, with a **Stay signed in** button.
- The absolute expiry is 12 hours from sign-in, even with continued activity and
  renewal. A fresh password login is then required.

Each browser login receives random session identifiers; state and deadlines live
in the Durable Object and survive restarts. Each account retains up to 20 browser
sessions; signing in on a 21st retires the oldest. Tabs in the same browser share
the server cookie, but each new website visit must still sign in in its own tab.
The cookie has no persistent Max-Age/Expires; the server still enforces its
15-minute idle and 12-hour absolute limits independently. This is scoped to one
host; production and preview sessions do not cross hosts.

The browser checks approximately every 30 seconds (sooner near a deadline), and
shows a reconnecting notice on network/server errors. Only a confirmed 401 ends
the browser session; a second check accommodates a concurrent tab's renewal.
Sleeping tabs check on return. The server still rejects an expired session even
if a browser timer is paused, removed, or changed. A valid stolen current session
can simulate activity until it is retired; rotation is an additional safeguard,
not a substitute for protecting the browser or preventing XSS.

The shared server timer is used by both portals. The browser-only admin timer
has been removed. Deploy the updated private Worker before the Pages update,
and verify configured test accounts before production activation.

This website cookie is separate from Firebase ID/refresh tokens and Firestore's
`gsessionid` connection parameter. No Firebase token lifetime, Authentication
user, mobile sign-in, or Firestore rule is changed. Direct Firestore access still
depends on Firebase Authentication and Security Rules: website idle expiry does
not revoke copied Firebase tokens or repair public database rules.

Static images, ZIPs, CSS, and browser JavaScript remain public. Middleware runs on
all paths so encoded paths cannot bypass the portal checks; this increases Pages
Function usage. Login requests have an additional 60-per-minute source-IP limit.
The signed session is a bearer credential: protect the browser/device and keep
the server keys private. This feature does not repair unrelated XSS or public
Firestore access. A deliberate attacker can trigger someone else's account
lockout; the manual recovery path is therefore necessary.

Published HTML, JavaScript and CSS are minified during `npm run build`, before
their cache versions are calculated. Editable repository files remain readable;
only the generated `dist` files are compacted. Source maps are omitted and the
build rejects recognizable private server credentials in client content. Module
paths, exported interfaces and classic-script globals are retained. This reduces
transfer size and readability; it is not encryption or an access-control layer.
Browser tools can still format or inspect downloaded code and network requests.

The website data gateway removes Firebase configuration and Firebase SDK imports
from published browser assets. Authorized API responses and browser UI code
remain inspectable; minification is not encryption. Firebase keys already used
in mobile apps remain public identifiers. Review their API restrictions with the
owner, excluding Gemini from Firebase client keys.

The existing teacher Active/Inactive control is separate from web login locks.
Initial staff must be enrolled in the private roster. Admin-created invitations
use private server approval for new teachers after their mobile registration.
The password-based flow currently does not implement an MFA challenge.

## Owner setup, before activation

1. Deploy the separate state Worker to the same Cloudflare account:

   ```powershell
   npx wrangler deploy --config wrangler.web-auth.jsonc
   ```

   Complete Cloudflare authentication yourself if prompted. This creates
   `imars-web-auth` and its SQLite Durable Object namespace. It does not activate
   website restrictions or modify Firebase accounts.

2. This Pages project manages bindings through `wrangler.jsonc`. Cloudflare's
   dashboard Add button is therefore disabled (its tooltip may say
   `wrangler.toml`, even though this repository uses JSONC).
   `env.production.durable_objects` now declares the `WEB_LOGIN_STATE` binding
   pointing to `WebLoginState` in `imars-web-auth`. It takes effect only after the
   state Worker exists in the same account and the updated Pages configuration
   is deployed. Deploy the Worker first; a Pages deployment that references a
   missing Worker will fail. Adding the binding does not enable protection.

   Preview binds to the separate private `imars-web-auth-preview` Worker. Deploy
   it with the same Worker config and `--name imars-web-auth-preview`, then verify
   there are no public targets. Preview enables both gateway flags but fails
   closed until its own credentials and approved roster are configured. It never
   uses the production session-state binding. Credentials for Preview require
   separate authorization; Production secrets cannot be read back for copying.

3. Add these encrypted Production secrets in the Pages project:

   - `WEB_SESSION_SECRET`: a new random key of at least 32 characters.
   - `WEB_MAINTENANCE_KEY`: a different random key; keep it in a password manager.
   - `WEB_STAFF_ACCOUNTS`: the approved account roster, as JSON. Use the actual
     Firebase Authentication UID and registered email, with the existing school ID.

   Example with dummy values (replace every account):

   ```json
   [
     {"id":"ADMIN1000","uid":"actual-admin-uid","email":"admin@example.test","role":"admin"},
     {"id":"TEACH1000","uid":"actual-teacher-uid","email":"teacher@example.test","role":"teacher"}
   ]
   ```

   The roster is server-owned because the current public Firestore profiles cannot
   be trusted to grant administrator access. Include every staff member who needs
   web access; IDs, UIDs, and emails must be unique. Keep real roster files and keys
   out of Git and chat. The data gateway additionally requires the dedicated
   Firebase service-account secret and IAM permissions in its setup guide.

   To generate each random key locally and copy it without printing it:

   ```powershell
   node -e "process.stdout.write(require('node:crypto').randomBytes(32).toString('base64url'))" | Set-Clipboard
   ```

4. Complete the service-account/IAM setup in [the gateway guide](web-data-gateway.md).
   Test with isolated state and approved test accounts. This branch has no legacy
   browser Firebase fallback and cannot sign in when backend setup is disabled.
5. Deploy the updated private Worker first, then activate the website deployment
   with both `WEB_LOGIN_ENABLED=true` and `WEB_DATA_ENABLED=true` after the
   prerequisites pass. Do not deploy incomplete configuration to production.

## Restore access

An authenticated roster administrator uses Manage Teachers > Unlock web login
(open-padlock button). The server permits that action only for teacher accounts.
This clears the attempt history and invalidates previous web cookies.

For a locked administrator, maintenance runs the provided local script with the
maintenance key supplied through an environment variable:

```powershell
$env:IMARS_WEB_MAINTENANCE_KEY = Read-Host -MaskInput 'Maintenance key'
node scripts/unlock-web-login.mjs ADMIN1000
Remove-Item Env:IMARS_WEB_MAINTENANCE_KEY
```

The script targets the existing `imars-web.pages.dev` site and never prints the
key. Removing a staff member from the approved roster immediately invalidates
their web cookie; do not delete the Durable Object namespace to unlock one user.

## Validation

Run `npm test` and `npm run build`. Tests cover cooldown boundaries, indefinite
locks, simultaneous attempts, persistent state across actor reconstruction,
forged/expired cookies, encoded admin paths, direct Firebase token bypass attempts,
administrator/maintenance recovery, and rejection of unconfigured browser login.
Session tests also cover random IDs, simultaneous-tab renewal, old-credential
retirement, passive polling, 15-minute idle and 12-hour absolute boundaries,
durable state, bounded sessions, connection failures, and browser warning/retry.
Cloudflare deployment and end-to-end sign-in with real accounts remain owner
checks after the binding and secrets exist.

## References

- [Cloudflare Pages Durable Object bindings](https://developers.cloudflare.com/pages/functions/bindings/#durable-objects)
- [Durable Objects pricing and free-tier limits](https://developers.cloudflare.com/durable-objects/platform/pricing/)
- [OWASP account lockout guidance](https://cheatsheetseries.owasp.org/cheatsheets/Authentication_Cheat_Sheet.html#account-lockout)
- [OWASP session renewal and timeouts](https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html#renewal-timeout)
