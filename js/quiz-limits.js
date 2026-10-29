// Decimal MB keeps the advertised maximum within the AI service's PDF limit.
export const MAX_QUIZ_FILE_BYTES = 50_000_000;
export const MAX_QUIZ_TEXT_CHARACTERS = 120_000;
export const PDF_REQUEST_TIMEOUT_MS = 300_000;
export const QUIZ_TYPES = Object.freeze({
  "multiple-choice": "Multiple choice",
  "true-false": "True or false",
  essay: "Essay",
  "identification-explanation": "Identification with explanation",
  "modified-true-false": "Modified true or false"
});
export const questionTypeLabel = type => Object.hasOwn(QUIZ_TYPES, type) ? QUIZ_TYPES[type] : "Unknown question type";
export const writtenQuestion = type => ["essay", "identification-explanation"].includes(type);

export function quizAssignmentScope(quiz) {
  const scope = quiz?.assignmentScope ?? "section";
  if (scope === "section") return typeof quiz?.sectionId === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(quiz.sectionId) ? scope : null;
  return ["all", "unassigned"].includes(scope) && quiz.sectionId === "" ? scope : null;
}

export function quizAssignedToSection(quiz, sectionId) {
  const scope = quizAssignmentScope(quiz);
  return Boolean(sectionId) && (scope === "all" || (scope === "section" && quiz.sectionId === sectionId));
}

export function normalizeQuizQuestion(question, type) {
  if (!Object.hasOwn(QUIZ_TYPES, type) || !question || typeof question !== "object" || Array.isArray(question)) return null;
  const validText = (value, maximum, empty = false) => typeof value === "string" && value.length <= maximum && (empty || value.trim().length > 0);
  if (!validText(question.text, 2000)) return null;
  const result = { text: question.text.trim(), options: [], correctIndex: -1 };
  if (writtenQuestion(type)) {
    if (!validText(question.answer, type === "essay" ? 8000 : 1000)) return null;
    if (type === "essay" ? !validText(question.rubric, 4000) : !validText(question.explanation, 4000)) return null;
    if (!Number.isInteger(question.points) || question.points < 1 || question.points > 100) return null;
    result.answer = question.answer.trim();
    result[type === "essay" ? "rubric" : "explanation"] = question[type === "essay" ? "rubric" : "explanation"].trim();
    result.points = question.points;
  } else {
    const count = type === "multiple-choice" ? 4 : 2;
    if (!Array.isArray(question.options) || question.options.length !== count || question.options.some(option => !validText(option, 1000))) return null;
    if (!Number.isInteger(question.correctIndex) || question.correctIndex < 0 || question.correctIndex >= count) return null;
    const options = question.options.map(option => option.trim());
    if (type === "multiple-choice") {
      const canonical = options.map(option => option.normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]/gu, ""));
      if (canonical.some(option => !option) || new Set(canonical).size !== count) return null;
    } else if (options[0].toLowerCase() !== "true" || options[1].toLowerCase() !== "false") return null;
    result.options = type === "multiple-choice" ? options : ["True", "False"];
    result.correctIndex = question.correctIndex;
    if (type === "modified-true-false") {
      if (!validText(question.correction, 4000, question.correctIndex === 0)) return null;
      result.correction = question.correctIndex === 1 ? question.correction.trim() : "";
    }
  }
  return result;
}

export function quizFileSizeError(size) {
  if (!Number.isSafeInteger(size) || size < 1) return "This file is empty or could not be read.";
  return size > MAX_QUIZ_FILE_BYTES ? "Please choose a file of 50 MB or less." : "";
}
