import { activityPercent } from "./activity-score.js";

const asMinutes = value => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;

export function testRawScore(result, kind) {
  const prefix = kind === "pre" ? "preTest" : "postTest";
  if (result?.[kind === "pre" ? "isPreTestCompleted" : "isPostTestCompleted"] !== true) return null;
  const total = result[prefix + "TotalQuestions"];
  let score = result[prefix + "Score"];
  if (kind === "post" && score == null && Array.isArray(result.postTestHeatmap) && result.postTestHeatmap.length === total && result.postTestHeatmap.every(value => typeof value === "boolean")) {
    score = result.postTestHeatmap.filter(value => value === true).length;
  }
  return typeof score === "number" && Number.isFinite(score) && typeof total === "number" && Number.isFinite(total) && total > 0 && score >= 0 && score <= total
    ? { score, total } : null;
}

export function activityMinutes(result) {
  const direct = asMinutes(result?.lessonTimeMinutes) ?? asMinutes(result?.arTimeMinutes);
  if (direct !== null) return direct;
  const devices = result?.learningTimeByDevice;
  if (!devices || typeof devices !== "object") return null;
  const seconds = Object.values(devices).reduce((sum, device) => {
    const amount = device?.lessonSeconds ?? device?.arSeconds;
    return sum + (typeof amount === "number" && Number.isFinite(amount) && amount >= 0 ? amount : 0);
  }, 0);
  return seconds > 0 ? seconds / 60 : null;
}

export function buildStudentActivityRecords(curriculum, sections, termLabels, termIds) {
  const records = [];
  curriculum.forEach((lessons, termIndex) => {
    const termId = termIds?.[termIndex] || `term_0${termIndex + 1}`;
    lessons.docs.forEach(lesson => {
      const lessonData = lesson.data();
      for (const { classDoc, students } of sections) {
        const classData = classDoc.data();
        const section = classData.SectionName || classData.sectionName || classData.name || classDoc.id;
        const grade = classData.gradeLevel || classData.GradeLevel || classData.grade || classData.Grade;
        const gradeLabel = grade ? (/^grade\b/i.test(String(grade)) ? String(grade) : `Grade ${grade}`) : "";
        const learners = students.map(({ studentDoc, results }) => {
          const result = results.find(entry => entry.termId === termId)?.lessonsSnap.docs.find(item => item.id === lesson.id)?.data();
          const student = studentDoc.data();
          const score = activityPercent(result);
          const preTest = testRawScore(result, "pre");
          const postTest = testRawScore(result, "post");
          const minutes = activityMinutes(result);
          const completed = result?.isLessonCompleted === true || result?.isARCompleted === true || result?.completed === true;
          return {
            name: student.displayName || student.fullName || "Student",
            score,
            preTest,
            postTest,
            rawScore: score === null ? null : Number(result.activityScore),
            totalScore: score === null ? null : Number(result.activityTotalQuestions ?? result.activityTotalPoints),
            minutes,
            completed
          };
        });
        const completedCount = learners.filter(learner => learner.completed).length;
        const times = learners.map(learner => learner.minutes).filter(value => value !== null);
        const scored = learners.map(learner => learner.score).filter(value => value !== null);
        records.push({
          key: `${termId}|${lesson.id}|${classDoc.id}`,
          title: lessonData.title || lessonData.name || lesson.id,
          term: termLabels[termId] || termId,
          section: `${gradeLabel ? `${gradeLabel} – ` : ""}${section}`,
          learnerCount: students.length,
          learners,
          completedCount,
          submittedCount: scored.length,
          averageMinutes: times.length ? Math.round(times.reduce((sum, value) => sum + value, 0) / times.length) : null,
          averageScore: scored.length ? Math.round(scored.reduce((sum, value) => sum + value, 0) / scored.length) : null
        });
      }
    });
  });
  return records;
}
