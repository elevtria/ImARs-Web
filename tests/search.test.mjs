import assert from "node:assert/strict";
import test from "node:test";
import { matchesSearch, normalizeSearch, personSearchText } from "../js/search.js";

test("names match across case, spacing, initials, Unicode spelling and punctuation variants", () => {
  for (const query of ["KURT S AMOR", "  kurt   s.  amor ", "AMOR KURT"]) {
    assert.equal(matchesSearch(query, "Kurt S. Amor"), true);
  }
  assert.equal(matchesSearch("O'CONNOR", "Liam O’Connor"), true);
  assert.equal(matchesSearch("DE-LA", "De–La Cruz"), true);
  assert.equal(matchesSearch("JOSE\u0301", "José"), true);
  assert.equal(matchesSearch("PEÑA", "Peña"), true);
  assert.equal(matchesSearch("PEÑA", "Pena"), false);
  assert.equal(matchesSearch("", "Any student"), true);
});

test("student IDs and full middle names use the same literal search as displayed names", () => {
  const data = { displayName: "Ana M. Peña", firstName: "Ana", middleName: "Maria Pilar", lastName: "Peña", schoolId: "0026270123" };
  const text = personSearchText("student-document", data);
  assert.equal(matchesSearch("0026270123", text), true);
  assert.equal(matchesSearch("MARIA PILAR", text), true);
  assert.equal(matchesSearch("PEÑA ANA", text), true);
  assert.equal(matchesSearch("other student", text), false);
  assert.equal(normalizeSearch("  0026270123  "), "0026270123");
  assert.equal(data.displayName, "Ana M. Peña");
});

test("search input remains literal text with no regular-expression or SQL wildcard behavior", () => {
  for (const query of [".*", "%", "[A-Z]+", "' OR 1=1--", "<script>"]) {
    assert.equal(matchesSearch(query, "Maria Clara"), false);
  }
});
