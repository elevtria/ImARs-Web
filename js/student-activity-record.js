import { activityPercent } from "./activity-score.js";

const asMinutes = value => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;

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

export function buildStudentActivityRecords(curriculum, sections, termLabels) {
  const records = [];
  curriculum.forEach((lessons, termIndex) => {
    const termId = `term_0${termIndex + 1}`;
    lessons.docs.forEach(lesson => {
      const lessonData = lesson.data();
      for (const { classDoc, students } of sections) {
        const classData = classDoc.data();
        const section = classData.SectionName || classData.sectionName || classData.name || classDoc.id;
        const grade = classData.gradeLevel || classData.GradeLevel || classData.grade || classData.Grade;
        const gradeLabel = grade ? (/^grade\b/i.test(String(grade)) ? String(grade) : `Grade ${grade}`) : "";
        const learners = students.map(({ studentDoc, results }) => {
          const result = results.find(entry => entry.termId === termId)?.lessonsSnap.docs.find(item => item.id === lesson.id)?.data();
          if (!result) return null;
          const student = studentDoc.data();
          const score = activityPercent(result);
          const minutes = activityMinutes(result);
          const completed = result.isLessonCompleted === true || result.isARCompleted === true || result.completed === true;
          if (!completed && score === null && minutes === null) return null;
          return {
            name: student.displayName || student.fullName || "Student",
            score,
            rawScore: score === null ? null : Number(result.activityScore),
            totalScore: score === null ? null : Number(result.activityTotalQuestions ?? result.activityTotalPoints),
            minutes,
            completed
          };
        }).filter(Boolean);
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
          averageMinutes: times.length ? Math.round(times.reduce((sum, value) => sum + value, 0) / times.length) : null,
          averageScore: scored.length ? Math.round(scored.reduce((sum, value) => sum + value, 0) / scored.length) : null
        });
      }
    });
  });
  return records;
}
