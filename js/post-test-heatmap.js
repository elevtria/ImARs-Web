// Answers are in presentation order on mobile. When postTestQuestionOrder is
// provided, map each answer back to its original curriculum index; when
// omitted on direct/synced mobile records, default to natural 0..N-1 order.
export function buildPostTestHeatmap(lesson, sections, termId) {
  const questions = Array.isArray(lesson?.data()?.postTest) ? lesson.data().postTest : [];
  const count = questions.length;
  const rows = questions.map((question, index) => ({
    index,
    text: typeof question?.question === "string" ? question.question : `Question ${index + 1}`,
    wrong: 0,
    answered: 0
  }));
  let mapped = 0, unmapped = 0;
  const seen = new Set();

  for (const section of sections || []) {
    for (const entry of section?.students || []) {
      const studentId = entry?.studentDoc?.id || entry?.document?.id || entry?.id;
      if (studentId) {
        if (seen.has(studentId)) continue;
        seen.add(studentId);
      }

      let data = null;
      if (Array.isArray(entry?.results)) {
        const termResult = entry.results.find(result => !termId || result.termId === termId);
        const lessonDoc = termResult?.lessonsSnap?.docs?.find(doc => doc.id === lesson.id);
        data = typeof lessonDoc?.data === "function" ? lessonDoc.data() : lessonDoc?.data;
      } else if (Array.isArray(entry?.lessons)) {
        const lessonDoc = entry.lessons.find(doc => doc?.id === lesson.id || doc?.path?.endsWith(`/${lesson.id}`));
        data = typeof lessonDoc?.data === "function" ? lessonDoc.data() : lessonDoc?.data;
      }

      if (data?.isPostTestCompleted !== true) continue;

      const answers = data.postTestHeatmap;
      let values = Array.isArray(answers)
        ? answers
        : answers && typeof answers === "object"
          ? Array.from({ length: count }, (_, index) => answers[String(index)])
          : [];

      // If a synced record only stored postTestScore without the boolean array,
      // synthesize a natural boolean array only when postTestQuestionOrder is not used.
      if (values.length === 0 && data.postTestQuestionOrder === undefined &&
          Number.isInteger(data.postTestScore) && data.postTestScore >= 0 && data.postTestScore <= count) {
        values = Array.from({ length: count }, (_, index) => index < data.postTestScore);
      }

      const order = data.postTestQuestionOrder === undefined
        ? Array.from({ length: count }, (_, index) => index)
        : data.postTestQuestionOrder;

      const totalQuestions = data.postTestTotalQuestions ?? values.length;

      if (!count ||
          totalQuestions !== count ||
          !Array.isArray(order) ||
          order.length !== count ||
          order.some(index => !Number.isInteger(index) || index < 0 || index >= count) ||
          new Set(order).size !== count ||
          values.length !== count ||
          values.some(value => typeof value !== "boolean") ||
          (data.postTestScore != null && data.postTestScore !== values.filter(value => value === true).length)) {
        unmapped++;
        continue;
      }

      mapped++;
      for (let index = 0; index < count; index++) {
        rows[order[index]].answered++;
        if (values[index] === false) rows[order[index]].wrong++;
      }
    }
  }

  return {
    rows: rows.map(row => ({ ...row, rate: row.answered ? (row.wrong / row.answered) * 100 : null })),
    mapped,
    unmapped
  };
}