import assert from "node:assert/strict";
import test from "node:test";
import { clearQuizWorkspace, readQuizWorkspace, saveQuizWorkspace } from "../js/quiz-workspace.js";

function storage() {
  const rows = new Map();
  return { getItem: key => rows.get(key) || null, setItem: (key, value) => rows.set(key, value), removeItem: key => rows.delete(key) };
}
function workspace() {
  return { profileId: "TEACH1000", step: "editor", view: "create", title: "Water", editorTitle: "Edited Water",
    type: "multiple-choice", difficulty: "Medium", generatedQuestions: [],
    editorQuestions: [{ id: "question-1", text: "Unsaved question", options: ["A", "B", "C", "D"], correctIndex: 0 }], dirty: true };
}

test("unsaved edits survive a new reader and are cleared after saving or logout", () => {
  const source = storage();
  assert.equal(saveQuizWorkspace("teacher-a", workspace(), source), true);
  const restored = readQuizWorkspace("teacher-a", "TEACH1000", source);
  assert.equal(restored.step, "editor");
  assert.equal(restored.editorTitle, "Edited Water");
  assert.equal(restored.editorQuestions[0].text, "Unsaved question");
  clearQuizWorkspace(source);
  assert.equal(readQuizWorkspace("teacher-a", "TEACH1000", source), null);
});

test("another account or teacher profile cannot recover the previous teacher's questions", () => {
  for (const [uid, profile] of [["teacher-b", "TEACH1000"], ["teacher-a", "TEACH1001"]]) {
    const source = storage();
    saveQuizWorkspace("teacher-a", workspace(), source);
    assert.equal(readQuizWorkspace(uid, profile, source), null);
    assert.equal(readQuizWorkspace("teacher-a", "TEACH1000", source), null);
  }
});

test("opening grading preserves the unsaved editor for refresh recovery", () => {
  const source = storage(), value = { ...workspace(), view: "grading" };
  saveQuizWorkspace("teacher-a", value, source);
  const restored = readQuizWorkspace("teacher-a", "TEACH1000", source);
  assert.equal(restored.view, "grading");
  assert.deepEqual(restored.editorQuestions, value.editorQuestions);
  assert.equal(restored.dirty, true);
});

test("invalid stored markup IDs, overlong arrays and unavailable storage cannot claim recoverability", () => {
  for (const modify of [
    value => { value.editorQuestions[0].id = '\" onclick=alert(1)'; },
    value => { value.editorQuestions = Array.from({ length: 51 }, () => value.editorQuestions[0]); },
    value => { value.type = "unknown"; }
  ]) {
    const source = storage(), value = workspace();
    modify(value);
    saveQuizWorkspace("teacher-a", value, source);
    assert.equal(readQuizWorkspace("teacher-a", "TEACH1000", source), null);
  }
  assert.equal(saveQuizWorkspace("teacher-a", workspace(), { setItem() { throw new Error("Quota exceeded"); } }), false);
});
