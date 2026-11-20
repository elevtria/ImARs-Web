import { quizReviewPoints } from "../js/quiz-limits.js";

export const hasPreliminaryScore = type => ["identification-explanation", "modified-true-false"].includes(type);

const normalize = value => typeof value === "string" ? value.normalize("NFKC").trim().replace(/\s+/gu, " ").toLowerCase() : "";

export function preliminaryQuizScore(quiz, answers) {
  if (!hasPreliminaryScore(quiz.type) || !Array.isArray(answers) || !quiz.questions?.length) return null;
  const byQuestion = new Map(answers.map(answer => [answer.questionId, answer]));
  let score = 0, maximum = 0;
  for (const question of quiz.questions) {
    const answer = byQuestion.get(question.id);
    if (!answer) return null;
    const points = quizReviewPoints(quiz.type, question);
    const correct = quiz.type === "identification-explanation"
      ? normalize(answer.value) === normalize(question.answer)
      : answer.optionIndex === question.correctIndex
        && (question.correctIndex === 0 || normalize(answer.correction) === normalize(question.correction));
    maximum += points;
    if (correct) score += points;
  }
  return { score, maximum };
}
