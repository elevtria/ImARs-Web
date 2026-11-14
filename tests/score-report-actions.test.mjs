import assert from "node:assert/strict";
import test from "node:test";
import { openScorePrintWindow, showScoreReport } from "../js/score-report-actions.js";

test("Print opens a dedicated report window and waits for fonts before opening the print dialog", async () => {
  const calls = [];
  const preview = { closed: false, document: { body: {}, fonts: { ready: Promise.resolve() },
    open: () => calls.push("open"), write: value => calls.push(value), close: () => calls.push("close") },
    requestAnimationFrame: callback => callback(), focus: () => calls.push("focus"), print: () => calls.push("print") };
  const original = globalThis.window;
  globalThis.window = { open: () => preview };
  try {
    assert.equal(openScorePrintWindow(), preview);
    assert.equal(preview.opener, null);
    assert.match(preview.document.body.textContent, /Preparing/);
    await showScoreReport({ html: "<html>Report only</html>" }, { mode: "print", preview, signal: new AbortController().signal });
    assert.deepEqual(calls, ["open", "<html>Report only</html>", "close", "focus", "print"]);
    globalThis.window.open = () => null;
    assert.throws(openScorePrintWindow, /Allow pop-ups/);
  } finally { globalThis.window = original; }
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
