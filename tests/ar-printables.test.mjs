import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import test from "node:test";
import { PDFDocument } from "../js/vendor/pdf-lib.esm.min.js";
import { teacherARCatalog } from "../js/teacher-ar-catalog.js";

const publicFile = name => readFileSync(new URL("../assets/guides/" + name, import.meta.url));
const manifest = JSON.parse(publicFile("ar-printables.json"));

test("the print collection uses exactly the original AR Classroom marker for every model", () => {
  assert.equal(manifest.markerCount, teacherARCatalog.length);
  assert.equal(manifest.modelCount, teacherARCatalog.length);
  assert.equal(manifest.markers.length, manifest.markerCount);
  assert.deepEqual(new Set(manifest.markers.map(card => card.modelId)), new Set(teacherARCatalog.map(model => model.id)));
  assert.equal(new Set(manifest.markers.map(card => card.pixelHash)).size, manifest.markerCount);
  assert.deepEqual(manifest.markers.map(card => card.number), Array.from({ length: manifest.markerCount }, (_, index) => index+1));
  for (const card of manifest.markers) {
    const model = teacherARCatalog.find(model => model.id === card.modelId);
    assert.equal(card.marker, model.marker);
    const bytes = readFileSync(new URL(".." + model.marker, import.meta.url));
    assert.equal(card.sourceSha256, createHash("sha256").update(bytes).digest("hex"), card.title);
    assert.deepEqual(card.sources, ["AR Classroom"]);
  }
});

test("both downloadable PDFs open successfully, have all their sheets, and stay below 15 MB", async () => {
  for (const [file, pages] of [["ImARs-AR-Flashcards.pdf", manifest.flashcardPages], ["ImARs-AR-Magazine.pdf", manifest.magazinePages]]) {
    const bytes = publicFile(file);
    assert.ok(bytes.length < 15 * 1024 * 1024, file);
    const pdf = await PDFDocument.load(bytes);
    assert.equal(pdf.getPageCount(), pages, file);
  }
  assert.equal(manifest.flashcardPages, Math.ceil(manifest.markerCount / 2));
  assert.equal(manifest.magazinePages % 4, 0, "a complete magazine signature has a multiple of four pages");
});
