# Topic and activity schedules

Teachers select one assigned section before editing dates or access. Topic
Scheduler, Activity Schedule and Year Progress all follow that selection.
Each available topic adds 25% to its four-topic term. Switching sections reuses
loaded lessons without reloading the page.

Activity Schedule lists 11 unique activities: four in Term 1, three in Term 2,
and four in Term 3. It omits the repeated Term 2 `lesson_04` activity and uses
Term 3 `lesson_01` for Longitudinal and Transverse Waves. Topic Scheduler keeps
all 12 curriculum lessons and their existing section schedules.

## Stored settings and authorization

Keep the existing four documents in each `terms/term_0{1,2,3}/lessons` collection.
Section settings are stored on the existing lesson document:

```json
{
  "isLocked": false,
  "scheduledDate": "",
  "sectionSchedules": {
    "CLASS_CODE_A": {
      "isLocked": true,
      "scheduledDate": "2027-01-20",
      "activityDeadlineUtc": "2027-01-20T09:00:00.000Z"
    },
    "CLASS_CODE_B": { "isLocked": false, "scheduledDate": "", "activityDeadlineUtc": "" }
  }
}
```

Map keys match class document IDs and student profiles' `classCode`.
An explicit section entry overrides the shared default; a section without an
entry inherits it. Invalid schedule fields stay locked. A future date locks a
lesson until that day. Manual Lock/Unlock clears the release date and preserves
the activity deadline. Release dates use the device's
local calendar, with website refreshes at midnight and when the tab resumes.

The authenticated website API accepts `sectionId`, `isLocked`, `scheduledDate`
and optional `activityDeadlineUtc`.
It checks class ownership and reads the class and lesson in one transaction.
It updates the selected entry while retaining other sections, shared defaults,
titles, ordering and test content. Concurrent changes return a conflict for retry.
Global edits and client-supplied section maps are rejected. Teachers without
assigned sections cannot edit. No new collection or composite index is needed.

Activity Schedule's **Make all available** button saves the 11 displayed
activities across all three terms in one atomic request for the selected section.
It clears their release dates and unlocks them, preserving saved deadlines,
other sections and shared defaults. The repeated Term 2 `lesson_04` is excluded,
just as it is from the activity list. Unsaved deadline edits stay in the form.

## Optional activity deadline

Activity Schedule provides a deadline field for the selected section. Teachers
enter the date and time in Philippine time (UTC+08:00); the website converts it
to a UTC ISO timestamp string ending in `Z`. For example, January 20, 2027 at
17:00 Philippine time saves as `2027-01-20T09:00:00.000Z`.

The value lives only inside `sectionSchedules/{sectionId}/activityDeadlineUtc`.
An empty string means no deadline; older entries without the field have the same
meaning. The API rejects malformed or non-UTC values. If a release date exists,
the deadline must be later than 00:00 on that release day in Philippine time.
Past deadlines remain editable so historical activity records can be retained.

Access changes that omit the deadline retain its current stored value, including
when an older website client saves. An explicit empty string removes it. Moving
a release date beyond an existing deadline is rejected; adjust or clear the
deadline in Activity Schedule first, or save both fields together there.
Other sections, curriculum content and shared defaults remain intact.

Mobile can read this metadata to identify unfinished activities as missed. The
website does not change activity availability or completion based on a deadline,
and this change does not implement missed-activity handling in mobile.

## Standalone mobile activities

`StudentActivitySchedule.cs` connects the 11 visible buttons in
`Student_Activity 1` to these same lesson documents. It reuses `LessonDisplay`
for identity checks, section overrides, dates, cached offline access and live
updates. Readers live beside the activity controller so hiding the menu during
play does not stop schedule updates. Each launch method checks confirmed access;
relocking or losing verified access closes the open activity.

| Mobile activity | Schedule document |
| --- | --- |
| States of Matter | `terms/term_01/lessons/lesson_01` |
| Physical and Chemical Changes | `terms/term_01/lessons/lesson_02` |
| Separation Techniques | `terms/term_01/lessons/lesson_03` |
| Circulatory System | `terms/term_01/lessons/lesson_04` |
| Food Web | `terms/term_02/lessons/lesson_01` |
| Simple Machines | `terms/term_02/lessons/lesson_02` |
| Sound Waves | `terms/term_02/lessons/lesson_03` |
| Longitudinal Waves | `terms/term_03/lessons/lesson_01` |
| Volcanic Activity | `terms/term_03/lessons/lesson_02` |
| Motions of the Earth | `terms/term_03/lessons/lesson_03` |
| Constellations | `terms/term_03/lessons/lesson_04` |

These activities share their mapped topic's section schedule. This integration
does not introduce independent activity-only dates or a new collection. Rebuild
and install the updated mobile app to activate the new button checks.

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
