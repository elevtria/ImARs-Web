import assert from "node:assert/strict";
import test from "node:test";
import { rankStudents } from "../js/leaderboard-ranking.js";
import { fixture } from "./fixtures/web-data.js";
import { protectWebsite } from "../server/web-auth.js";

function verifiedTeacherFixture() {
  const app = fixture();
  app.data.get("users/TEACH1000").authEmailVerified = true;
  return app;
}

test("rankings filter sections before ranking and preserve ties without mutating the roster", () => {
  const students = [
    { id: "b", name: "Bella", classId: "A", points: 200 },
    { id: "c", name: "Cara", classId: "B", points: 500 },
    { id: "a", name: "Ana", classId: "A", points: 200 },
    { id: "d", name: "Dan", classId: "A", points: 0 }
  ];
  const overall = rankStudents(students);
  assert.deepEqual(overall.map(row => [row.name, row.rank]), [["Cara", 1], ["Ana", 2], ["Bella", 2], ["Dan", 4]]);
  assert.deepEqual(rankStudents(students, "A").map(row => [row.name, row.rank]), [["Ana", 1], ["Bella", 1], ["Dan", 3]]);
  assert.equal(students[0].name, "Bella");
  assert.equal(students[0].rank, undefined);
  assert.deepEqual(rankStudents([], "A"), []);
});

test("leaderboard reads only assigned active students and their saved app points", async () => {
  const app = verifiedTeacherFixture();
  const cookie = await app.login();
  app.data.get("users/0026271000").gamification = { totalPoints: 320, badgeCounts: { private: 10 } };
  app.data.get("users/0026271001").gamification = { totalPoints: 999 };
  app.data.set("users/archived", { role: "student", classCode: "A", active: false, gamification: { totalPoints: 900 } });
  const response = await app.call({ action: "student-page", includePoints: true, includeCounts: false }, cookie);
  assert.equal(response.status, 200);
  const page = await response.json();
  assert.deepEqual(page.students.map(row => [row.document.id, row.document.data.totalPoints]), [["0026271000", 320]]);
  assert.equal(page.students[0].document.data.gamification, undefined);
  assert.equal((await app.call({ action: "student-page", sectionId: "B", includePoints: true }, cookie)).status, 403);
  const regular = await (await app.call({ action: "student-page", includeCounts: false }, cookie)).json();
  assert.equal(regular.students[0].document.data.totalPoints, undefined);
});

test("older students without points and malformed counters start at zero", async () => {
  const app = verifiedTeacherFixture();
  const cookie = await app.login();
  for (const points of [undefined, -5, "100", 4.5, Number.MAX_SAFE_INTEGER + 1]) {
    app.data.get("users/0026271000").gamification = points === undefined ? undefined : { totalPoints: points };
    const response = await app.call({ action: "student-page", includePoints: true, includeCounts: false }, cookie);
    assert.equal((await response.json()).students[0].document.data.totalPoints, 0);
  }
  assert.equal((await app.call({ action: "student-page", includePoints: "yes" }, cookie)).status, 400);
});

test("the leaderboard page requires sign-in and app points cannot be read by administrators", async () => {
  const app = verifiedTeacherFixture();
  const response = await protectWebsite({ env: app.env,
    request: new Request("https://imars.example.test/leaderboard"),
    next: async () => assert.fail("An anonymous visitor must not receive the portal page") });
  assert.equal(response.status, 302);
  assert.match(response.headers.get("Location"), /^\/login/);
  const admin = await app.login("ADMIN1000", "admin");
  assert.equal((await app.call({ action: "student-page", includePoints: true }, admin)).status, 403);
});
