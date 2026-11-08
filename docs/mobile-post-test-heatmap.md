# Mobile prompt: question mapping for the website heatmap

The web heatmap is in Analytics, before Topic Completion Rate. It filters by
term, assigned section and topic, and counts incorrect post-test answers only.
It reuses loaded reports and does not fetch student records for a topic change.

The current `QuizManager.cs` shuffles `activeQuestions`, then appends correctness
to `resultsList` in that shuffled order. `StudentTestProgress.cs` saves that list
as `postTestHeatmap` without a question mapping. Existing arrays therefore cannot
reliably identify which curriculum question was answered incorrectly. The web
excludes such records instead of labeling guesses as question-level statistics.
Historical mappings cannot be reconstructed from the boolean list alone.

Paste the following into the mobile project:

```text
Add reliable question mapping for the ImARs website's post-test heatmap.

Inspect and reuse Assets/SCRIPTS/QuizManager.cs and StudentTestProgress.cs.
Keep randomized presentation and all existing scoring, one-attempt checks,
offline persistence, retries and achievement behavior.

Before shuffling, retain every question's original zero-based index in the
selected lesson's postTest array. Save postTestQuestionOrder alongside
postTestHeatmap in the same lesson result document:
users/{studentId}/test_results/{termId}/lessons/{lessonId}

postTestQuestionOrder[i] must identify the original curriculum index of the
question represented by postTestHeatmap[i]. Example: order [2,0,1] and heatmap
[false,true,true] means curriculum question 3 was wrong; questions 1 and 2
were correct. true always means correct, false means incorrect.

Persist the mapping in the pending offline submission before leaving the quiz
scene. Upload it atomically with the matching postTestHeatmap, total, score,
completion flag and submission ID. Require a full permutation of 0..total-1.
Do not add a mapping to an old queued result whose original order is unknown.
Never guess or backfill mappings for historical shuffled results.

The website already reads postTestQuestionOrder. No new endpoint is required.
Update the mobile heatmap too if it currently treats presentation order as
curriculum order or counts correct answers while labeling them as wrong.

Test shuffled order, all-correct/all-wrong cases, offline save/restart/retry,
duplicate sync, correct term/lesson scoping and old results without mappings.
Build a new APK and explain which future results will populate the web chart.
```
