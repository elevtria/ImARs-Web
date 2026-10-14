# Topic Scheduler and Firebase

The scheduler's term counts, badges, and Year Progress all count topics currently
unlocked for learners. This is availability, rather than student completion.
Each unlocked topic adds 25% to a four-topic term.

## Existing lesson documents

Keep four lesson documents in each collection:

- `terms/term_01/lessons/{lessonId}`
- `terms/term_02/lessons/{lessonId}`
- `terms/term_03/lessons/{lessonId}`

The scheduler updates the existing document IDs. No new collection or progress
field is needed; counts are calculated from the lesson settings.

| Field | Type | Purpose |
| --- | --- | --- |
| `isLocked` | Boolean | `true` locks the lesson, unless its scheduled release date has arrived. |
| `scheduledDate` | String | `YYYY-MM-DD` release date, or `""` for manual availability. |
| `lessonOrder` | Number, optional | Controls display order; without it, lesson IDs are sorted numerically. |
| `title` | String, optional | Topic title displayed in the scheduler. |

For example, a lesson scheduled for October 20, 2026 uses:

```json
{
  "isLocked": true,
  "scheduledDate": "2026-10-20"
}
```

Saving a future date writes both fields together and locks the topic until that
day. Saving today's date unlocks it immediately. Manual Lock/Unlock and Lock
All/Unlock All write `isLocked` and clear `scheduledDate`, replacing the schedule.
Clearing a scheduled date preserves the topic's current effective availability.
Existing fields are added automatically by the next save on an existing lesson
document. Missing `isLocked` currently behaves as unlocked; set it explicitly to
`true` if an existing lesson should start locked.

## Firestore rules

The signed-in teacher must be allowed to read the lesson collections and update
`isLocked` and `scheduledDate` on these documents. Use the project's existing
teacher role check. If rules restrict changed fields, include both fields in the
allowed update list. Keep students' access read-only.

The page uses collection snapshot listeners for live updates. It does not require
a new composite index. Rules are not stored in this repository, so deployed
permissions have not been verified.

## Student app integration

The student app must calculate availability from both fields, using the same
calendar-date convention as the teacher device:

```text
locked = isLocked AND (scheduledDate is empty OR today < scheduledDate)
```

The website refreshes this derived state at midnight and when a suspended tab
becomes visible. It does not write `isLocked: false` back to Firebase when a
release date arrives. If the student app reads only `isLocked`, automatic releases
will require a student-app change to read `scheduledDate` too, or a server-side
scheduled job to update the Boolean. Student-app code is not in this repository.

Reference: [Firestore realtime listeners](https://firebase.google.com/docs/firestore/query-data/listen)
and [rules for specific fields](https://firebase.google.com/docs/firestore/security/rules-fields).
