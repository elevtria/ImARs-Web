# Topic and activity schedules

Teachers select one assigned section before editing dates or access. Topic
Scheduler, Activity Schedule and Year Progress all follow that selection.
Each available topic adds 25% to its four-topic term. Switching sections reuses
loaded lessons without reloading the page.

## Stored settings and authorization

Keep the existing four documents in each `terms/term_0{1,2,3}/lessons` collection.
Section settings are stored on the existing lesson document:

```json
{
  "isLocked": false,
  "scheduledDate": "",
  "sectionSchedules": {
    "CLASS_CODE_A": { "isLocked": true, "scheduledDate": "2027-01-20" },
    "CLASS_CODE_B": { "isLocked": false, "scheduledDate": "" }
  }
}
```

Map keys match class document IDs and student profiles' `classCode`.
An explicit section entry overrides the shared default; a section without an
entry inherits it. Invalid schedule fields stay locked. A future date locks a
lesson until that day. Manual Lock/Unlock clears the date. Dates use the device's
local calendar, with website refreshes at midnight and when the tab resumes.

The authenticated website API accepts `sectionId`, `isLocked`, `scheduledDate`.
It checks class ownership and reads the class and lesson in one transaction.
It updates the selected entry while retaining other sections, shared defaults,
titles, ordering and test content. Concurrent changes return a conflict for retry.
Global edits and client-supplied section maps are rejected. Teachers without
assigned sections cannot edit. No new collection or composite index is needed.

## Mobile rollout

Compatible source is in `C:/Users/marie/Imars/Assets/SCRIPTS/LessonDisplay.cs`
and `LessonScheduleRules.cs`. LessonDisplay resolves the current Firebase UID's
unique active student profile and its verified classCode. It listens for section
changes, closes inaccessible lessons and rechecks after account changes. Existing
lesson title/order validation remains in place. Online access waits for fresh
profile and lesson snapshots; offline access uses cached snapshots bound to that
UID. Missing identity or invalid section settings cannot open a lesson.

Rebuild and distribute the updated mobile app before relying on section-specific
student releases. Older installed apps keep reading the shared defaults, which
website saves retain. The mobile administrator's shared-default editor remains
a legacy control; section-specific scheduling is managed on the website.

Production Firestore rules are managed outside this repository; this change does
not deploy or relax them. Students should retain read-only schedule access.
Website writes use the authenticated server gateway. No R2 storage is required.
