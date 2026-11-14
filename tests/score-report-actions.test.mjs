import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { showScoreReport, createScoreReportOutput } from "../js/score-report-actions.js";

test("repeated exports reuse only public fonts and logo while fetching fresh scores each time", async () => {
  const original = globalThis.fetch;
  let assetReads = 0, studentReads = 0, quizReads = 0, yearReads = 0;
  globalThis.fetch = async url => {
    assetReads++;
    assert.ok(studentReads > 0, "student fetching starts before public resources finish loading");
    return new Response(await readFile(url));
  };
  const doc = (id, data) => ({ id, data: () => data });
  const services = {
    fetchPage: async () => {
      studentReads++;
      return { classes: [doc("A", { SectionName: "A" })], students: [{ classId: "A", studentDoc: doc("S1", { displayName: "Demo Student" }), results: [] }],
        curriculum: { curriculumSnap: { docs: [doc("lesson_01", { title: "Topic" })] } }, cursor: null };
    },
    fetchQuizzes: async () => { quizReads++; return { quizzes: [], items: [] }; },
    fetchSchoolYear: async () => { yearReads++; return 2026; }
  };
  const options = { sectionId: "A", termId: "term_01", teacherName: "Teacher", signal: new AbortController().signal };
  try {
    const download = await createScoreReportOutput({ ...options, mode: "download" }, services);
    assert.ok(download.pdfBytes);
    assert.equal(download.html, undefined);
    const print = await createScoreReportOutput({ ...options, mode: "print" }, services);
    assert.ok(print.html);
    assert.equal(print.pdfBytes, undefined);
    assert.equal(assetReads, 3);
    assert.equal(studentReads, 2);
    assert.equal(quizReads, 2);
    assert.equal(yearReads, 2);
  } finally { globalThis.fetch = original; }
});

test("Download creates a real PDF file; cancellation cannot download or print stale results", async () => {
  const original = { document: globalThis.document, create: URL.createObjectURL, revoke: URL.revokeObjectURL, timer: globalThis.setTimeout };
  let file, timer, clicked = 0, removed = 0;
  const link = { click: () => clicked++, remove: () => removed++ };
  globalThis.document = { body: { append() {} }, createElement: () => link };
  URL.createObjectURL = blob => { file = blob; return "blob:report"; };
  URL.revokeObjectURL = url => assert.equal(url, "blob:report");
  globalThis.setTimeout = (callback, ms) => { assert.equal(ms, 60_000); timer = callback; };
  try {
    const output = { pdfBytes: new Uint8Array([37, 80, 68, 70, 45]), filename: "ImARs_Hydrogen_term_01.pdf" };
    await showScoreReport(output, { mode: "download", signal: new AbortController().signal });
    assert.equal(file.type, "application/pdf");
    assert.equal(await file.text(), "%PDF-");
    assert.equal(link.download, output.filename);
    assert.equal(clicked, 1);
    assert.equal(removed, 1);
    timer();
    const controller = new AbortController(); controller.abort();
    await assert.rejects(showScoreReport(output, { mode: "download", signal: controller.signal }), { name: "AbortError" });
    assert.equal(clicked, 1);
  } finally {
    globalThis.document = original.document; URL.createObjectURL = original.create; URL.revokeObjectURL = original.revoke; globalThis.setTimeout = original.timer;
  }
});
