# Firestore rules compatibility review

Status: the website and Unity source at `C:/Users/marie/Imars` have been inspected.
Compatible auth changes, a server gateway, rules and isolated tests were prepared
locally after the owner approved mobile code changes. No production rules,
Authentication accounts or live database records have been changed or accessed.
See `security/README.md` for the actual prerequisites and cutover steps. Local
compilation/emulator checks do not replace acceptance testing on the built app.

## Current rule supplied by the owner

The recursive rule permits unauthenticated reads, creates, updates, and deletes
on every document before August 4, 2027. Firebase Authentication in the login UI
does not restrict a direct database request under this rule. At the deadline,
this rule stops allowing client requests; it does not delete existing data.

## Browser protections — October 20, 2026

The website escapes database names, titles, scan labels and teacher document IDs
before including them in generated HTML. The existing Pages middleware applies a
Content Security Policy that blocks inline scripts, HTML event handlers, string
evaluation, plugins and framing by other websites. Existing inline chart styles
and the current Firebase, QR, spreadsheet and PDF libraries remain permitted.
Local browser checks cover blocked scripts and successful PDF rendering; these
checks use synthetic data and do not access production student records.

The Firebase web configuration remains public because the browser Firebase SDK
requires it. It is not a database password, and hiding it would not enforce data
access. Private Gemini and service-account credentials belong only in encrypted
server secrets; no service-account private key or hardcoded private API secret
was found in the public source scan. Review the Firebase key's API restrictions
in Google Cloud separately, particularly to ensure it cannot call paid AI APIs.

These browser protections do not replace Firestore rules. The last rules supplied
by the owner permit public database access, and the account gateway/rules rollout
below is still pending. No production rules or security activation flags are
changed by the browser protections.

## Website operations to preserve

| Feature | Firestore paths and operations | Source |
| --- | --- | --- |
| Legacy Teacher ID / Admin ID login | Read `users/{schoolId}` before Authentication, then query `users` by `uid` after sign-in | `js/login.js` |
| Protected website login | Resolve staff ID using the private Cloudflare roster; authenticate before website profile reads | `server/web-auth.js`, `js/login.js` |
| Profile and navigation | Query `users` by the authenticated `uid` | `js/teacher-nav.js`, `js/admin-view.js` |
| Teacher reports | Query own `classes` by `teacherId`, then `users` students by `classCode`; read nested `test_results/{term}/lessons` | `js/dashboard.js`, `js/teacher-report-data.js`, `js/student-records.js` |
| Admin reports | Query all teacher/student profiles; read student result collections | `js/admin-report-data.js` |
| Add section / batch import | Create/update own class, update teacher `sections`, create/merge student profiles | `js/batch-upload.js` |
| Student ID allocation | Read all student profiles to check IDs and calculate the next sequence | `js/batch-upload.js` |
| Teacher invitations | Admin creates a pre-approved teacher profile without a Firebase `uid`; mobile registration fills it later | `js/manage-teachers.js` |
| Student invitations | Teacher creates student profiles without a `uid`, including ownership, class, email and initial progress | `js/batch-upload.js` |
| Teacher status / deletion | Admin updates `active`/`status` or deletes a teacher profile | `js/manage-teachers.js` |
| Admin profile | Merge selected profile fields into the UID-linked admin document | `js/admin-profile.js` |
| Lesson schedule | Listen to all lesson documents under three terms; update `isLocked` and `scheduledDate`, including batched changes | `js/topic-scheduler.js` |
| Generated quizzes | Teacher queries by `teacherUid`, saves questions and correct answers with section ownership, deletes own quizzes | `js/quiz-generator.js` |
| Offline result transfer | Teacher reads student profile, merges progress fields and nested lesson results; appends own recent scan history | `js/sync-offline-results.js` |
| Marker download progress | Teacher reads/writes `users/{teacherId}/offlineSync/markerDownloads` | `js/offline-sync.js` |
| Shared school year | Read `webSettings/schoolYear`; administrator updates selected year and audit fields | `js/school-year.js` |
| AI question generation | Server uses the caller's Firebase token to query their profile and read the selected class | `functions/api/generate-quiz.js` |

## Compatibility issues that must be resolved before deployment

1. A blanket authenticated-user rule blocks legacy ID lookups before sign-in.
   The existing protected server login avoids public profile lookup but is not
   activated yet. Check equivalent mobile lookups before closing public reads.
2. User document IDs are school IDs, not Firebase UIDs. A rule that assumes
   `users/{request.auth.uid}` exists will not match this model.
3. Newly invited teachers/students do not have UIDs yet. A rule requiring a UID
   on every profile creation breaks both invitation flows. Verify the mobile
   process for securely claiming an invitation and preventing duplicate claims.
4. Roles, UIDs and class/teacher ownership must be protected against client
   reassignment. Existing profile roles cannot alone establish trusted staff
   access while the old rule allows anyone to modify them. Use an independently
   verified staff authorization source, provisioned through a trusted server or
   administrator, before relying on roles for access control.
5. Teacher student-ID allocation and mobile reporting currently query every
   student. The candidate retains those existing school-wide student reads and
   limits teacher writes to assigned students/classes. Class-only reporting and
   server-side ID allocation would be a separate change; the current migration
   does not provide class-only confidentiality between teachers.
6. Rules authorize a whole query, rather than filtering forbidden documents.
   Test actual collection queries and listeners, not only individual reads.
7. Teacher QR imports intentionally write student progress. Allowing students
   only to write their own results is insufficient for that teacher feature.
   Inspect allowed fields and verify the student's teacher/class relationship.
8. Quiz documents include correct answers. Student access needs review alongside
   the mobile quiz reader before granting access to these entire documents.
9. Lesson schedules are global under `terms`, not per class. Preserving that
   design requires an explicit staff scheduling permission; do not accidentally
   invent a class-specific scope absent from the existing data model.

## Required mobile review

The inspected `Assets/SCRIPTS` uses `users`, `classes`, `terms`, nested result
collections and `did_you_know`. The mobile CSV import can create a student invite
without `role` or `uid`; the activation server normalizes that invite to a student
only after email verification. Teacher signup is implemented in the misleadingly
named `Admin_CreAccount.cs`; it does not create administrator roles.

Mobile quiz results use `StudentTestProgress` transactions. Reading/AR time uses
`StudentLearningProgress` and per-device maps from `LearningProgressData`.
Achievements update `gamification.totalPoints` and badge counters transactionally;
these fields are included in the candidate. Teacher QR transfer intentionally
merges the student profile and lesson results. Lesson content includes answers
for offline grading, so authorized lesson readers can still inspect that content.

The prepared mobile edits affect three auth scripts and add one helper; the
reviewable diff is `security/mobile/compatible-login.patch`. The installed APK
and live rules have not been updated. The old APK's public profile lookups are
incompatible with the strict candidate and require a coordinated client update.

## Test and release approach

- Use a demo Firebase project in the local Emulator Suite, with explicit rules
  and synthetic records. The emulator clients must not use production resources.
- Exercise every website and mobile operation above using their real document
  paths, query constraints, identity states and update fields.
- Also prove that anonymous callers, unrelated students/teachers and forged
  role/UID/ownership updates are rejected. An authenticated catch-all is not an
  adequate replacement.
- Preserve the visible workflows by adapting affected calls before publishing
  stricter rules. Record any required authorization provisioning and data updates.
- Retain the current rules for diagnosis and an emergency rollback, and publish
  only after the complete flow and denial tests pass. The old rule is insecure
  and is not a suitable permanent fallback.

References: [rule conditions](https://firebase.google.com/docs/firestore/security/rules-conditions),
[queries and rules](https://firebase.google.com/docs/firestore/security/rules-query),
[rules testing](https://firebase.google.com/docs/rules/unit-tests), and
[Firestore emulator](https://firebase.google.com/docs/emulator-suite/connect_firestore).
