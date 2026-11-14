import { scoreOverride } from "./lesson-score.js";
import { testRawScore } from "./student-activity-record.js";

export const SCHOOL_NAME = "Pintong Gubat Elementary School";
export const SCHOOL_ADDRESS = "City of Dasmariñas, Cavite";

export function reportScore(score, maximum) {
  return Number.isFinite(score) && Number.isFinite(maximum) && maximum > 0 && score >= 0 && score <= maximum ? `${score}/${maximum}` : "-";
}

export function reportLessonScores(data = {}) {
  const edited = scoreOverride(data, "activity");
  const pre = testRawScore(data, "pre"), post = testRawScore(data, "post");
  const activity = edited ? reportScore(edited.score, edited.maximum) : Object.hasOwn(data, "activityRawMaximum")
    ? reportScore(data.activityRawScore, data.activityRawMaximum)
    : reportScore(data.activityScore, data.activityTotalQuestions ?? data.activityTotalPoints);
  return [activity, reportScore(pre?.score, pre?.total), reportScore(post?.score, post?.total)];
}

// Read a fresh, complete section instead of exporting only the current screen's 25 rows.
export async function collectScoreReport({ termId, sectionId, search = "", teacherName, signal, now = new Date(), onProgress = () => {}, onStage = () => {} },
  { fetchPage, fetchQuizzes, fetchSchoolYear }) {
  const check = () => signal?.throwIfAborted();
  check();
  onStage("Loading student scores…");
  const schoolYearRequest = Promise.resolve().then(fetchSchoolYear).then(value => ({ value }), error => ({ error }));
  const students = new Map(), seen = new Set();
  let cursor = null, lessons, sectionName, activitySyncPending = false;
  do {
    check();
    const page = await fetchPage({ termId, sectionId, cursor, batchSize: 100, includeCounts: false, includeCurriculum: !lessons, rawActivityScores: true });
    check();
    const section = page.classes.find(row => row.id === sectionId)?.data();
    if (!section) throw new Error("This section is no longer available. Choose a section and try again.");
    sectionName = section.SectionName || section.sectionName || section.name || sectionId;
    if (page.curriculum) lessons = page.curriculum.curriculumSnap.docs.map(row => {
      const data = row.data();
      return { id: row.id, title: data.title || data.name || data.topicTitle || row.id };
    });
    for (const row of page.students) {
      if (row.classId !== sectionId) throw new Error("The report contains a different section. Please try again.");
      students.set(row.studentDoc.id, row);
    }
    activitySyncPending ||= page.activitySyncPending === true;
    onProgress(students.size);
    cursor = page.cursor;
    if (cursor) {
      const key = JSON.stringify(cursor);
      if (seen.has(key)) throw new Error("The student list changed while preparing the report. Please try again.");
      seen.add(key);
    }
  } while (cursor);
  if (!lessons?.length) throw new Error("There are no topics available for this term.");
  const query = search.trim().toLowerCase();
  const selected = [...students.values()].filter(row => {
    const data = row.studentDoc.data();
    return (data.displayName || data.fullName || "Student").toLowerCase().includes(query);
  });
  if (!selected.length) throw new Error("No students match the selected section and search.");
  onStage("Loading quiz results…");
  const scores = new Map();
  let quizzes, quizSignature;
  for (let offset = 0; offset < selected.length; offset += 75) {
    check();
    const requests = [];
    for (let index = offset; index < Math.min(offset + 75, selected.length); index += 25) {
      requests.push(fetchQuizzes(selected.slice(index, index + 25).map(row => row.studentDoc.id)));
    }
    const batches = await Promise.all(requests);
    check();
    for (const batch of batches) {
      const signature = JSON.stringify(batch.quizzes.map(quiz => [quiz.id, quiz.title]));
      if (quizSignature && quizSignature !== signature) throw new Error("Quiz assignments changed while preparing the report. Please try again.");
      quizSignature = signature;
      quizzes = batch.quizzes;
      for (const item of batch.items) scores.set(`${item.studentId}/${item.quizId}`, item);
    }
  }
  const schoolYearResult = await schoolYearRequest;
  if (schoolYearResult.error) throw schoolYearResult.error;
  const year = schoolYearResult.value;
  check();
  const schoolYear = Number.isInteger(year) && year >= 2000 && year <= 2100 ? `${year}-${year + 1}` : "Not configured";
  return {
    schoolName: SCHOOL_NAME, schoolAddress: SCHOOL_ADDRESS, schoolYear, section: sectionName,
    term: `Term ${Number(termId.slice(-1))}`, termId, teacherName, generatedAt: now.toISOString(),
    generatedLabel: new Intl.DateTimeFormat("en-PH", { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Taipei" }).format(now),
    generatedDate: new Intl.DateTimeFormat("en-CA", { year: "numeric", month: "2-digit", day: "2-digit", timeZone: "Asia/Taipei" }).format(now),
    search: search.trim(), totalStudents: students.size, activitySyncPending, lessons,
    quizzes: quizzes.map(quiz => ({ id: quiz.id, title: quiz.title || "Quiz" })),
    students: selected.map(row => {
      const details = row.studentDoc.data();
      const results = new Map((row.results.find(result => result.termId === termId)?.lessonsSnap.docs || []).map(doc => [doc.id, doc.data()]));
      return { name: details.displayName || details.fullName || "Student",
        lessons: lessons.map(lesson => reportLessonScores(results.get(lesson.id))),
        quizzes: quizzes.map(quiz => {
          const item = scores.get(`${row.studentDoc.id}/${quiz.id}`);
          return item?.status === "pending-review" ? "Pending review" : reportScore(item?.score, item?.maximum);
        }) };
    })
  };
}

export function scoreReportFilename(report) {
  const section = report.section.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-zA-Z0-9_-]+/g, "-").replace(/^-|-$/g, "").slice(0, 65) || "section";
  return `ImARs_${section}_${report.termId}_${report.generatedDate}.pdf`;
}
