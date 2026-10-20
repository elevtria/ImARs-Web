# Website login protection

Implemented locally, disabled until Cloudflare is configured. The private
`imars-web-auth` state Worker was deployed on 2026-10-16; the website binding,
secrets, staff roster and activation remain pending. See
`security/deployment-status.md`. Nothing here
disables Firebase Authentication users, changes Firestore rules, or changes
mobile sign-in. Do not describe this as protection for the database: the public
Firestore rules previously shared still permit direct data access independently
of the website login. Already downloaded pages/data cannot be withdrawn.

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

Both portals now require a fresh website login for a new visit. Firebase browser
authentication is migrated from persistent local storage to this tab's session
storage. The login page clears an older browser login; a direct URL, bookmark,
new tab without a current visit, or restored history entry also returns to login.
Navigation inside the website and reloads during the same visit keep sign-in.
Browser restoration behavior varies, so the website also checks the navigation
entry and its per-tab visit marker instead of relying on closing events alone.

The marker contains only the UID, portal role and start time, and expires after
12 hours. It is a UI lifecycle marker, not a database or server credential. Page
data callbacks wait for Firebase initialization and a live, unique UID-linked
staff profile with the expected role and active status. An unavailable check
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

The old 10-minute browser-only admin timer remains only when web protection is
disabled, including plain static development. Upgrading an already enabled
installation requires existing staff to sign in again: older stateless cookies
have no matching server session record. Deploy the state Worker before the Pages
update, then verify both portals in Preview before production activation.

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

The existing teacher Active/Inactive control is separate from web login locks.
New staff must be enrolled in the server roster before protected web login works.
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

   Preview currently has no state binding and must be configured with a separate
   test Worker before enabling Preview security. Keep its credentials, roster and
   session state separate from production. The main configuration intentionally
   does not give Preview the production state binding.

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
   out of Git and chat. No Firebase service-account key is needed.

   To generate each random key locally and copy it without printing it:

   ```powershell
   node -e "process.stdout.write(require('node:crypto').randomBytes(32).toString('base64url'))" | Set-Clipboard
   ```

4. Deploy these website changes with `WEB_LOGIN_ENABLED` unset/false first.
   Check the build, binding, roster and recovery key using a separate Preview
   environment and test accounts. Preview needs separate keys, a separate Worker
   namespace, and its own roster; never test guesses against real teachers.
5. After those checks, set the Pages variable `WEB_LOGIN_ENABLED` to the exact
   string `true` and redeploy. Until then, the existing login is retained.
   Enabling it with missing configuration fails closed. On first use, existing
   Firebase browser sessions need a fresh website login to obtain the web cookie.

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
administrator/maintenance recovery, and the unchanged disabled-mode login flow.
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
