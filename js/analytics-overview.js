import { testRawScore } from "./student-activity-record.js";
import { recordedLearningMinutes } from "./learning-duration.js";

const mean = values => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
export function buildAnalyticsOverview(report, sectionId, termId) {
  const section = report.sections.find(row => row.classDoc.id === sectionId);
  const students = (section?.students || []).filter(row => row.studentDoc.data().active !== false &&
    !["inactive", "disabled", "archived", "deleted"].includes(String(row.studentDoc.data().status || "").toLowerCase()));
  const support = new Map(), allPre = [], allPost = [], pairedChanges = [];
  const lessons = (report.curriculumSnap?.docs || []).map(lesson => {
    const info = lesson.data(), title = info.title || info.name || lesson.id;
    const pre = [], post = [], changes = [], ar = [], module = [];
    for (const student of students) {
      const data = student.results.find(row => row.termId === termId)?.lessonsSnap.docs.find(row => row.id === lesson.id)?.data() || {};
      const before = testRawScore(data, "pre"), after = testRawScore(data, "post");
      if (before) pre.push(before.score / before.total * 100);
      if (after) {
        const percent = after.score / after.total * 100;
        post.push(percent);
        if (percent < 60) {
          const id = student.studentDoc.id, profile = student.studentDoc.data();
          if (!support.has(id)) support.set(id, { id, name: profile.displayName || profile.fullName || id, lessons: [] });
          support.get(id).lessons.push({ title, score: after.score, maximum: after.total });
        }
      }
      if (before && after) changes.push(after.score / after.total * 100 - before.score / before.total * 100);
      const arMinutes = recordedLearningMinutes(data, "arTimeMinutes", "arSeconds") ?? recordedLearningMinutes(data, "arNavigationTimeMinutes", "arNavigationSeconds");
      const moduleMinutes = recordedLearningMinutes(data, "lessonTimeMinutes", "lessonSeconds");
      if (arMinutes !== null) ar.push(arMinutes);
      if (moduleMinutes !== null) module.push(moduleMinutes);
    }
    allPre.push(...pre); allPost.push(...post); pairedChanges.push(...changes);
    return { id: lesson.id, title, pre: mean(pre), post: mean(post), change: mean(changes), pairs: changes.length,
      preCount: pre.length, postCount: post.length, ar: mean(ar), module: mean(module), arCount: ar.length, moduleCount: module.length };
  });
  return { students: students.length, lessons, pre: mean(allPre), post: mean(allPost), change: mean(pairedChanges),
    assessments: allPre.length + allPost.length, possibleAssessments: students.length * lessons.length * 2,
    support: [...support.values()].sort((a, b) => b.lessons.length - a.lessons.length || a.name.localeCompare(b.name)) };
}
