# Generated quizzes: mobile API and teacher reviews

Implemented in `server/student-quizzes.js`. Production enablement requires the
release checks below; source changes alone do not change the live API.

Quizzes are created as unassigned, locked drafts. Assignment happens in the
library's Schedule controls. `assignmentScope` is `section` (one `sectionId`),
`all` (empty `sectionId`, every currently owned section), or `unassigned` (empty
`sectionId`, draft only). Older quizzes without this field keep their single
section. All-section student queries still constrain teacher UID/profile; safe
responses use the authenticated student's actual section ID. No quiz copies or
per-section question downloads are needed.

## Student protocol

`POST /api/student-quizzes/{list,start,access,submit}`, JSON and
`Authorization: Bearer <Firebase ID token>`. No website cookies. The handler
validates the token through Google, checks project/issuer/lifetime and the
privileged Auth record's revocation time and verified email, then resolves the
active student profile, class and current teacher. The staff `/api/web-data`
route retains its staff session requirement.

All successful replies include verified `context` with `uid`, `studentId`,
`sectionId`, `teacherProfileId`, `teacherUid`. Lists/start/access include
`serverTimeUtc`. Replies are private/no-store; errors are JSON `{code,error}`.

| Action | Request | Result |
| --- | --- | --- |
| list | `{limit:20,cursor:""}` | `items`, `pageCursor`, `nextCursor` |
| start | `{quizId,revision,attemptId}` | same attempt ID, safe `quiz` summary and `questions` |
| access | same as start | `allowed`, quiz/revision/attempt IDs |
| submit | `{assignmentId,revision,attemptId,startedAtUtc,completedAtUtc,answers}` | persisted receipt |

Summary fields: id/title/teacherName/sectionId/teacherProfileId/teacherUid/type/
gradingMode/availability/availableAt/createdAt/schemaVersion/questionCount/revision.
`revision` is Firestore updateTime. Questions contain only id/text/options/points.
IDs and option order are unchanged. No keys or guides are sent to students.

Answer fields are questionId, optionIndex, value, explanation, correction.
Multiple choice and true/false use optionIndex and empty strings. Essay uses
optionIndex=-1 and value (up to 8000). Identification uses optionIndex=-1,
value (up to 1000), explanation (up to 4000). Modified false answers require
correction (up to 4000). The last three types always await teacher review.

Drafts are hidden; future scheduled summaries may be shown locked. Start and
submit check release using server time. availableAt never acts as a deadline.
Scope/class/quiz authorization is reread inside the write transaction. A changed
revision or payload conflicts. Transaction contention is retryable (503).

## Queries, cursors and storage

Lists execute one field-projected, section/teacher-scoped query capped at 21
rows and return at most 20. Questions are excluded in Firestore's projection.
The section predicate includes the student's section and the empty all-section
value. Ordering is createdAt descending plus document name descending. Signed
continuation tuples work after deletion of the boundary document. Tokens bind
the authenticated UID, profile, class and teacher and expire after 12 hours.
Signed page membership refreshes use one teacher-scoped projected name-IN query
(max 20), then recheck section eligibility. They omit the section-IN predicate
to stay below Firestore's disjunction limit.
They retain page membership while updating/removing relocked/deleted cards.
New quizzes enter a fresh traversal when the inbox is reopened.

Identity checks read five scoped documents per list: student account mapping,
student profile, class, teacher profile, teacher account mapping. Auth lookups
are bounded to the caller and assigned teacher. There are no roster scans or
per-card lookups. The legacy fallback, when ACCOUNT_ACCESS_ENABLED is not true,
uses a unique UID query limited to two profiles.

Private storage:

- `users/{studentId}/generated_quiz_attempts/{32-hex-attemptId}` stores the
  reservation, immutable scope/revision, submitted answers, canonical payload
  hash, original receipt, server submission time and later teacher review.
- `generatedQuizRevisions/{sha256(quizId,revision)}` keeps one immutable private
  question/guide snapshot per started revision. This lets teachers review the
  actual submitted quiz after later edits and avoids duplicating large guides
  inside every student's answer document.

Raw quiz/attempt/revision reads and writes remain denied to students. Attempts
are separate from lesson test_results. A retry of a committed identical payload
returns the original receipt after relocking, without another write. Reviews
preserve that receipt and the original answers. New attempts use new IDs;
resuming the same start ID does not create another reservation. This implements
multiple attempts; stricter per-quiz policies can be introduced server-side.

## Teacher review

The existing Quiz Generator library has a Review answers button for the three
manual-review formats. `/api/quiz-review/action` requires the normal teacher
website session and current class/quiz ownership. `list` pages pending attempts
20 at a time; `open` loads one attempt and its original private guide; `grade`
validates per-question scores against that snapshot and persists scores,
feedback, reviewer identity and server review time transactionally. Students
cannot call this route. The dialog cancels work when closed or accounts change.

## Release procedure

1. Run `npm test`, `npm run build`, and the Firestore emulator integration test.
2. Merge `security/firestore.student-quizzes.indexes.json` into the project's
   deployed index configuration and deploy those indexes; wait until ready.
   Deny direct client access to generatedQuizzes, private attempts, revision
   snapshots and account bindings. `firestore.quiz-release.rules` is a narrow
   transition from the original test rules: it also makes class membership and
   identity fields server-managed, while retaining own progress/avatar writes.
   The full migration candidate is separate and must not be deployed blindly.
   Legacy top-level profile/curriculum reads remain unchanged by this release;
   this is not a complete database access-control migration. Verify the actual
   deployed rules before enabling; emulator rules alone are not sufficient.
3. With server-only `FIREBASE_SERVICE_ACCOUNT_JSON`, run
   `node scripts/backfill-quiz-metadata.mjs` (dry run, at most 100 records).
   Review invalid IDs. Apply a bounded batch with `--apply`, then continue with
   `--after=<nextCursor>`. `--pages=N` permits at most 100 bounded pages. Writes
   use updateTime preconditions and touch only server-derived questionCount.
   New website saves calculate questionCount and preserve original createdAt.
4. Deploy website Functions and assets. Reuse the existing private
   FIREBASE_SERVICE_ACCOUNT_JSON, WEB_SESSION_SECRET and WEB_LOGIN_STATE
   binding. Optional STUDENT_QUIZ_CURSOR_SECRET can separate cursor signing.
   Set STUDENT_QUIZZES_ENABLED=true only after indexes/backfill/rules checks.
   Student requests are limited to 60 per UID per minute by the existing
   private Durable Object. This includes list/start/access/submit together.
5. Verify with a real signed-in student, then put
   `{"baseUrl":"https://VERIFIED-HOST/api/student-quizzes"}` into Unity's
   `Assets/Resources/StudentGeneratedQuizApi.json` (plus its .meta). Build and
   test the device. No service-account key belongs in Unity or client assets.

The API remains disabled when its flag is absent. Production activation and a
real-device sign-in test require the deployment owner's configured account.

## Validation

`tests/student-quizzes.test.mjs` and `tests/quiz-review.test.mjs` cover tokens,
scope/reassignment, drafts/releases, all types, cursor forgery/expiry/deleted
boundaries, duplicate receipts, conflicting payloads, transaction races, teacher
reviews and bounded migrations. `tests/student-quizzes.emulator.mjs` exercises
the actual REST projection, tuple/name-IN queries, transaction wire format,
receipt replay and raw-document rules against 1,000 synthetic Firestore records.
It uses a demo project only; mocked identity checks there are complemented by
the token/authentication unit tests. Neither establishes production readiness.

Reference: [Firebase ID token verification](https://firebase.google.com/docs/auth/admin/verify-id-tokens),
[Firestore structured queries](https://firebase.google.com/docs/firestore/reference/rest/v1/StructuredQuery).
