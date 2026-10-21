# Dedicated account-gateway identity — owner setup

Updated on 2026-10-21 for the website data gateway. No Google service account, IAM role, permission grant or
private key was created by preparing these files.

Use project `imars-db-a733b`. Create a dedicated service account named
`imars-account-gateway`; do not replace or change the existing Firebase Admin SDK
service account used by other parts of the system. The intended dedicated email
is `imars-account-gateway@imars-db-a733b.iam.gserviceaccount.com`.

## Permission definition for review

`account-gateway-role.json` is an importable custom-role definition with proposed
role ID `imarsAccountGateway`. It has only these permissions:

| Permission | Used by the prepared code |
| --- | --- |
| `datastore.entities.get` | Read a profile/private binding; check profile state. |
| `datastore.entities.list` | Query `users` by UID and reject duplicate mappings. |
| `datastore.entities.create` | Create a private `_accountAccess/{uid}` document. |
| `datastore.entities.update` | Atomically link a verified UID to an unused invitation. |
| `datastore.entities.delete` | Delete an authorized quiz or administrator-selected teacher profile. |
| `datastore.databases.get` | Begin/roll back transactions that verify role and class ownership with each save. |
| `firebaseauth.users.get` | Compare existing Auth UIDs and emails with the independently reviewed migration manifest. |

Firestore IAM is enforced independently of client Security Rules. These IAM
permissions are not collection- or field-specific: the service identity can
read/create/update/delete other documents within its grant scope. The server must keep
enforcing the fixed paths and invitation/identity checks in
`server/account-access.js` and `server/web-data.js`. Do not describe the key itself as limited to only one
collection. No Firebase Auth create/update/delete, IAM-management
or rules-publishing permission is included.

The website server uses REST `get`, transactional `batchGet`, `runQuery`, atomic
`commit`, `beginTransaction` and `rollback`. Its intended permissions were checked against the official
API tables; production IAM still needs a real authorized check before activation.
Do not expand the role to Owner, Editor or Firebase Admin to silence a failure.

## Owner workflow

1. In Google Cloud Console, select `imars-db-a733b` and open IAM & Admin > Service
   Accounts. Check the existing list before creating the dedicated account. Do
   not grant project-wide basic roles or change an existing app service account.
2. Create/review the custom project role using exactly the definition above and
   grant it only to the dedicated service account. Confirm the correct project
   and exact principal before saving. Creation/grants are owner actions, not
   performed by these files.
3. When the role and account are verified, the owner can create a JSON key for
   that dedicated account. If an organization policy prohibits keys, use the
   organization's approved approach; do not weaken that policy.
4. Keep the JSON private and untracked. Store its complete contents only as the
   encrypted Production Pages secret `FIREBASE_SERVICE_ACCOUNT_JSON` for
   `imars-web`. Never place it in a normal Wrangler `vars` property, website/Unity
   assets, repository, screenshot or chat. Read-only validation may use the
   process environment without printing its value.
5. Keep `ACCOUNT_ACCESS_ENABLED` unset/false while completing the account manifest,
   compatible app tests, source integration and coordinated cutover documented
   in `../README.md`. Creating the key alone does not activate protection or
   change Firebase records.

References:

- [Create a dedicated service account](https://docs.cloud.google.com/iam/docs/service-accounts-create)
- [Create custom IAM roles](https://docs.cloud.google.com/iam/docs/creating-custom-roles)
- [Firestore method permission requirements](https://docs.cloud.google.com/firestore/native/docs/security/iam#required_permissions_for_api_methods)
- [Firebase Auth administrative lookup permission](https://docs.cloud.google.com/identity-platform/docs/reference/rest/v1/projects.accounts/lookup)
