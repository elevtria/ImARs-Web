// Answers are in presentation order on mobile. Require an explicit mapping
// back to the curriculum; legacy shuffled arrays cannot identify questions.
export function buildPostTestHeatmap(lesson, sections, termId) {
  const questions = Array.isArray(lesson?.data()?.postTest) ? lesson.data().postTest : [];
  const rows = questions.map((question, index) => ({ index, text: typeof question?.question === "string" ? question.question : `Question ${index + 1}`, wrong: 0, answered: 0 }));
  let mapped = 0, unmapped = 0;
  const seen = new Set();
  for (const section of sections) for (const { studentDoc, results } of section.students) {
    if (seen.has(studentDoc.id)) continue;
    seen.add(studentDoc.id);
    const data = results.find(result => result.termId === termId)?.lessonsSnap.docs.find(result => result.id === lesson.id)?.data();
    if (data?.isPostTestCompleted !== true) continue;
    const order = data.postTestQuestionOrder, count = questions.length, answers = data.postTestHeatmap;
    const values = Array.isArray(answers) ? answers : answers && typeof answers === "object" ? Array.from({ length: count }, (_, index) => answers[String(index)]) : [];
    if (!count || data.postTestTotalQuestions !== count || !Array.isArray(order) || order.length !== count ||
        order.some(index => !Number.isInteger(index) || index < 0 || index >= count) || new Set(order).size !== count ||
        values.length !== count || values.some(value => typeof value !== "boolean") ||
        (data.postTestScore != null && data.postTestScore !== values.filter(value => value === true).length)) {
      unmapped++; continue;
    }
    mapped++;
    for (let index = 0; index < count; index++) {
      rows[order[index]].answered++;
      if (values[index] === false) rows[order[index]].wrong++;
    }
  }
  return { rows: rows.map(row => ({ ...row, rate: row.answered ? row.wrong / row.answered * 100 : null })), mapped, unmapped };
}
