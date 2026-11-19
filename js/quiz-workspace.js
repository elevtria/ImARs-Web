import { QUIZ_TYPES } from "./quiz-limits.js";

const key = "imars-quiz-workspace-v1";
const lifetime = 12 * 60 * 60_000;
const questions = rows => Array.isArray(rows) && rows.length <= 50 && rows.every(row =>
  row && typeof row.text === "string" && row.text.length <= 10000 &&
  typeof row.id === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(row.id) &&
  Array.isArray(row.options) && row.options.length <= 10 && row.options.every(option => typeof option === "string"));

export function clearQuizWorkspace(storage) {
  try { (storage || window.sessionStorage)?.removeItem(key); } catch {}
}

export function saveQuizWorkspace(uid, value, storage) {
  if (!uid) return false;
  try {
    const encoded = JSON.stringify({ uid, savedAt: Date.now(), value });
    if (encoded.length > 2 * 1024 * 1024) return false;
    (storage || window.sessionStorage).setItem(key, encoded);
    return true;
  } catch { return false; }
}

export function readQuizWorkspace(uid, profileId, storage) {
  try {
    const source = storage || window.sessionStorage;
    const saved = JSON.parse(source.getItem(key));
    const value = saved?.value;
    if (saved?.uid === uid && saved.savedAt <= Date.now() && Date.now() - saved.savedAt < lifetime &&
        value?.profileId === profileId && ["setup", "review", "editor"].includes(value.step) &&
        ["create", "library"].includes(value.view) && Object.hasOwn(QUIZ_TYPES, value.type) &&
        typeof value.title === "string" && typeof value.editorTitle === "string" &&
        ["Easy", "Medium", "Hard"].includes(value.difficulty) && questions(value.generatedQuestions) && questions(value.editorQuestions)) return value;
    clearQuizWorkspace(source);
  } catch { clearQuizWorkspace(storage); }
  return null;
}
