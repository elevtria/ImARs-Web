import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { before, after, beforeEach, test } from "node:test";
import { initializeTestEnvironment, assertSucceeds, assertFails } from "@firebase/rules-unit-testing";
import { doc, collection, query, where, orderBy, limit, getDoc, getDocs, setDoc, updateDoc, deleteDoc,
  serverTimestamp, arrayUnion, writeBatch, runTransaction, onSnapshot } from "firebase/firestore";
import { accountAccess } from "../server/account-access.js";
import { FirestoreAdmin } from "../server/firestore-admin.js";
import { prepareAccessBootstrap } from "../server/account-bootstrap.js";

const projectId = "demo-imars-security-review";
if (process.env.FIRESTORE_EMULATOR_HOST !== "127.0.0.1:58087") throw Error("Use only the isolated 127.0.0.1:58087 emulator; production is forbidden.");
let environment;
before(async () => {
  environment = await initializeTestEnvironment({ projectId, firestore: { host: "127.0.0.1", port: 58087,
    rules: await readFile(new URL("../security/firestore.candidate.rules", import.meta.url), "utf8") } });
});
after(async () => { await environment?.cleanup(); });
const baseUsers = {
  ADMIN1000: { uid: "admin-a", role: "admin", active: true, displayName: "Admin" },
  TEACH1000: { uid: "teacher-a", role: "teacher", active: true, displayName: "Teacher A", sections: ["A"] },
  TEACH1001: { uid: "teacher-b", role: "teacher", active: true, displayName: "Teacher B", sections: ["B"] },
  "0026271000": { uid: "student-a", role: "student", active: true, classCode: "A", teacherId: "TEACH1000", avatarId: "scientist_01", gamification: { level: 1, totalPoints: 0 } },
  "0026271001": { uid: "student-b", role: "student", active: true, classCode: "B", teacherId: "TEACH1001" }
};
beforeEach(async () => {
  await environment.clearFirestore();
  await environment.withSecurityRulesDisabled(async context => {
    const db = context.firestore(), batch = writeBatch(db);
    for (const [id, data] of Object.entries(baseUsers)) {
      batch.set(doc(db, "users", id), data);
      batch.set(doc(db, "_accountAccess", data.uid), { profileId: id, role: data.role, active: true, authEmail: data.uid + "@example.test" });
    }
    batch.set(doc(db, "classes", "A"), { teacherId: "TEACH1000", SectionName: "A" });
    batch.set(doc(db, "classes", "B"), { teacherId: "TEACH1001", SectionName: "B" });
    for (const term of ["term_01", "term_02", "term_03"]) {
      batch.set(doc(db, "terms", term), { title: term });
      for (let index = 1; index <= 4; index++) batch.set(doc(db, "terms", term, "lessons", "lesson_0" + index), {
        title: "Lesson " + index, isLocked: false, scheduledDate: "", preTest: [{ question: "Example", answer: "A" }]
      });
    }
    batch.set(doc(db, "did_you_know", "fact"), { text: "Science fact" });
    batch.set(doc(db, "webSettings", "schoolYear"), { startYear: 2026, endYear: 2027 });
    await batch.commit();
  });
});
const database = uid => uid ? environment.authenticatedContext(uid, { email: uid + "@example.test", email_verified: true }).firestore() : environment.unauthenticatedContext().firestore();
const resultPath = id => "users/" + id + "/test_results/term_01/lessons/lesson_01";

test("anonymous and unprovisioned Auth accounts cannot read profiles, lists, lessons, answers, results or identity mappings", async () => {
  for (const uid of [null, "outsider"]) {
    const db = database(uid);
    for (const path of ["users/0026271000", "users/TEACH1000", "classes/A", "terms/term_01", "terms/term_01/lessons/lesson_01", "_accountAccess/admin-a", resultPath("0026271000")]) {
      await assertFails(getDoc(doc(db, path)));
    }
    await assertFails(getDocs(collection(db, "users")));
    await assertFails(setDoc(doc(db, "users", "forged"), { uid: "outsider", role: "admin" }));
  }
});
test("real UID profile queries work for all three roles, while students cannot enumerate other users", async () => {
  for (const uid of ["student-a", "teacher-a", "admin-a"]) {
    const db = database(uid);
    const snapshot = await assertSucceeds(getDocs(query(collection(db, "users"), where("uid", "==", uid))));
    assert.equal(snapshot.size, 1);
  }
  const student = database("student-a");
  await assertFails(getDoc(doc(student, "users", "0026271001")));
  await assertFails(getDocs(query(collection(student, "users"), where("role", "==", "student"))));
  await assertFails(getDocs(query(collection(student, "users"), where("uid", "==", "student-b"))));
});
test("school reports retain the website and mobile teacher/admin queries and nested result reads", async () => {
  for (const uid of ["teacher-a", "admin-a"]) {
    const db = database(uid);
    await assertSucceeds(getDocs(query(collection(db, "users"), where("role", "==", "student"))));
    await assertSucceeds(getDocs(query(collection(db, "users"), where("role", "==", "student"), where("classCode", "==", "A"))));
    await assertSucceeds(getDocs(collection(db, "classes")));
    await assertSucceeds(getDocs(query(collection(db, "classes"), where("teacherId", "==", "TEACH1000"))));
    await assertSucceeds(getDocs(collection(db, "users", "0026271001", "test_results", "term_01", "lessons")));
    await assertSucceeds(getDoc(doc(db, "users", "0026271000", "test_results", "legacy_lesson")));
  }
  const admin = database("admin-a");
  await assertSucceeds(getDocs(query(collection(admin, "users"), where("role", "==", "teacher"))));
  await assertFails(getDoc(doc(database("teacher-a"), "users", "ADMIN1000")));
});
test("student avatar, first class-code acknowledgement, badge and points transactions preserve other fields", async () => {
  const db = database("student-a"), ref = doc(db, "users", "0026271000");
  await assertSucceeds(updateDoc(ref, { avatarId: "scientist_02" }));
  await assertSucceeds(updateDoc(ref, { hasSeenClassCode: true }));
  await assertSucceeds(runTransaction(db, async transaction => {
    const data = (await transaction.get(ref)).data();
    transaction.update(ref, { "gamification.totalPoints": Math.max(10, data.gamification.totalPoints), "gamification.badgeCounts.AccuracyBadgeCount": 1 });
  }));
  assert.equal((await getDoc(ref)).data().gamification.level, 1);
  for (const change of [{ role: "admin" }, { uid: "other" }, { classCode: "B" }, { active: false }, { "gamification.level": 100 }]) {
    await assertFails(updateDoc(ref, change));
  }
  await assertFails(setDoc(doc(db, "_accountAccess", "student-a"), { role: "admin", profileId: "ADMIN1000", active: true }));
});
test("student pre/post tests, realtime progress and offline learning-time transactions retain their document shape", async () => {
  const db = database("student-a"), ref = doc(db, resultPath("0026271000"));
  await assertSucceeds(runTransaction(db, async transaction => {
    await transaction.get(ref);
    transaction.set(ref, { lessonId: "lesson_01", termId: "term_01", totalQuestions: 5, timestamp: serverTimestamp(),
      preTestScore: 4, preTestHeatmap: [true, true, true, true, false], preTestTotalQuestions: 5, isPreTestCompleted: true }, { merge: true });
  }));
  await assertSucceeds(setDoc(ref, { totalQuestions: 10, postTestScore: 8, postTestTotalQuestions: 10, isPostTestCompleted: true,
    postTestHeatmap: [true, true, true, true, true, true, true, true, false, false], timestamp: serverTimestamp() }, { merge: true }));
  await assertSucceeds(runTransaction(db, async transaction => {
    await transaction.get(ref);
    transaction.set(ref, { arTimeMinutes: 2.5, lessonTimeMinutes: 3, arNavigationTimeMinutes: 0.5,
      learningTimeByDevice: { device1: { arSeconds: 150, lessonSeconds: 180, arNavigationSeconds: 30 } }, isARCompleted: true, isLessonCompleted: true }, { merge: true });
  }));
  await new Promise((resolve, reject) => { const stop = onSnapshot(ref, snapshot => { if (!snapshot.metadata.fromCache) { stop(); resolve(); } }, reject); });
  await assertFails(setDoc(doc(db, resultPath("0026271001")), { preTestScore: 5, preTestTotalQuestions: 5 }));
  await assertFails(updateDoc(ref, { preTestScore: 999 }));
  await assertFails(updateDoc(ref, { role: "admin" }));
  await assertFails(deleteDoc(ref));
});
test("lesson and fact readers work; only staff can change schedule fields, including a four-document batch", async () => {
  const student = database("student-a"), teacher = database("teacher-a");
  await assertSucceeds(getDocs(collection(student, "terms")));
  await assertSucceeds(getDocs(collection(student, "terms", "term_01", "lessons")));
  await assertSucceeds(getDocs(collection(student, "did_you_know")));
  const batch = writeBatch(teacher);
  for (let i = 1; i <= 4; i++) batch.update(doc(teacher, "terms", "term_01", "lessons", "lesson_0" + i), { isLocked: true, scheduledDate: "2026-11-01" });
  await assertSucceeds(batch.commit());
  await assertSucceeds(runTransaction(teacher, async transaction => { const ref = doc(teacher, "terms/term_01/lessons/lesson_01"); await transaction.get(ref); transaction.update(ref, { isLocked: false, scheduledDate: "" }); }));
  await assertFails(updateDoc(doc(student, "terms/term_01/lessons/lesson_01"), { isLocked: false, scheduledDate: "" }));
  await assertFails(updateDoc(doc(teacher, "terms/term_01/lessons/lesson_01"), { title: "Tampered", preTest: [] }));
});
test("class creation, mobile duplicate-ID checks, CSV pre-registrations and own-section edits work", async () => {
  const db = database("teacher-a");
  await assertSucceeds(getDoc(doc(db, "classes", "NEW")));
  await assertSucceeds(setDoc(doc(db, "classes", "NEW"), { teacherId: "TEACH1000", SectionName: "New section" }));
  await assertSucceeds(updateDoc(doc(db, "classes", "NEW"), { SectionName: "Renamed" }));
  await assertSucceeds(updateDoc(doc(db, "users", "TEACH1000"), { sections: arrayUnion("New section") }));
  await assertSucceeds(getDoc(doc(db, "users", "0026279999")));
  await assertSucceeds(setDoc(doc(db, "users", "0026279999"), { classCode: "NEW", displayName: "Mobile CSV student", providedEmail: "invited@example.test", gamification: { level: 1, totalPoints: 0 } }));
  await assertSucceeds(setDoc(doc(db, "users", "0026279998"), { schoolId: "0026279998", role: "student", classCode: "NEW", teacherId: "TEACH1000", providedEmail: "web@example.test", isRegistered: false }));
  await assertFails(setDoc(doc(db, "users", "forged-teacher"), { role: "teacher", classCode: "NEW" }));
  await assertFails(setDoc(doc(db, "users", "forged-uid"), { role: "student", classCode: "NEW", uid: "attacker" }));
  await assertFails(updateDoc(doc(db, "classes", "B"), { teacherId: "TEACH1000" }));
  await assertSucceeds(deleteDoc(doc(db, "classes", "NEW")));
});
test("teacher QR imports preserve legacy missing schoolId, class assignment, results, scan history and downloads", async () => {
  const db = database("teacher-a"), ref = doc(db, "users", "0026271000");
  await assertSucceeds(setDoc(ref, { schoolId: "0026271000", displayName: "Student", fullName: "Student", role: "student", classCode: "A", lastQrSyncAt: serverTimestamp() }, { merge: true }));
  await assertSucceeds(setDoc(doc(db, resultPath("0026271000")), { lessonId: "lesson_01", preTestScore: 4, preTestTotalQuestions: 5,
    isPreTestCompleted: true, postTestScore: 8, postTestTotalQuestions: 10, isPostTestCompleted: true, isLessonCompleted: true, timestamp: serverTimestamp() }, { merge: true }));
  await assertSucceeds(setDoc(doc(db, "users/TEACH1000/recent_scans/one"), { moduleName: "Student report synced", scanType: "qr", timestamp: serverTimestamp() }));
  await assertSucceeds(getDocs(query(collection(db, "users/TEACH1000/recent_scans"), orderBy("timestamp", "desc"), limit(5))));
  const download = doc(db, "users/TEACH1000/offlineSync/markerDownloads");
  await assertSucceeds(setDoc(download, { requestedFiles: arrayUnion("markers.zip"), updatedAt: serverTimestamp() }, { merge: true }));
  await assertSucceeds(getDoc(download));
  await assertFails(updateDoc(doc(db, "users", "0026271001"), { classCode: "A", teacherId: "TEACH1000" }));
  await assertFails(setDoc(doc(db, resultPath("0026271001")), { preTestScore: 4, preTestTotalQuestions: 5 }));
  await assertFails(getDoc(doc(database("student-a"), "users/TEACH1000/recent_scans/one")));
});
test("admin invitations, teacher status/delete, own profile updates and shared school year work", async () => {
  const db = database("admin-a");
  await assertSucceeds(setDoc(doc(db, "users", "TEACH1002"), { schoolId: "TEACH1002", role: "teacher", providedEmail: "new@example.test", isRegistered: false, active: true, status: "invited" }));
  await assertSucceeds(updateDoc(doc(db, "users", "TEACH1001"), { active: false, status: "inactive" }));
  await assertFails(getDocs(query(collection(database("teacher-b"), "classes"), where("teacherId", "==", "TEACH1001"))));
  await assertSucceeds(deleteDoc(doc(db, "users", "TEACH1002")));
  await assertSucceeds(setDoc(doc(db, "users", "ADMIN1000"), { uid: "admin-a", schoolId: "ADMIN1000", role: "admin", roleLabel: "School Administrator",
    displayName: "New display", fullName: "New display", providedEmail: "contact@example.test", email: "contact@example.test", school: "School", department: "Science", phone: "123", updatedAt: serverTimestamp() }, { merge: true }));
  await assertSucceeds(setDoc(doc(db, "webSettings/schoolYear"), { startYear: 2027, endYear: 2028, updatedBy: "admin-a", updatedAt: serverTimestamp() }));
  await assertSucceeds(getDoc(doc(database("teacher-a"), "webSettings/schoolYear")));
  await assertFails(setDoc(doc(database("teacher-a"), "webSettings/schoolYear"), { startYear: 2028, endYear: 2029, updatedBy: "teacher-a", updatedAt: serverTimestamp() }));
});
test("teacher quiz libraries retain section ownership while students cannot download answer-bearing generated quizzes", async () => {
  const db = database("teacher-a"), ref = doc(db, "generatedQuizzes", "quiz1");
  const quiz = { teacherUid: "teacher-a", teacherProfileId: "TEACH1000", sectionId: "A", title: "Quiz", questions: [{ correctIndex: 0, options: ["a", "b"] }] };
  await assertSucceeds(setDoc(ref, quiz));
  await assertSucceeds(getDocs(query(collection(db, "generatedQuizzes"), where("teacherUid", "==", "teacher-a"))));
  await assertFails(getDoc(doc(database("teacher-b"), "generatedQuizzes", "quiz1")));
  await assertFails(getDoc(doc(database("student-a"), "generatedQuizzes", "quiz1")));
  await assertFails(updateDoc(ref, { teacherUid: "teacher-b" }));
  await assertFails(updateDoc(ref, { sectionId: "B" }));
  await assertSucceeds(deleteDoc(ref));
});
test("old public registration and client-written staff mappings are deliberately rejected before migration activation", async () => {
  const admin = database("admin-a");
  await setDoc(doc(admin, "users", "TEACH1002"), { role: "teacher", providedEmail: "new@example.test", isRegistered: false });
  await assertFails(getDoc(doc(database(null), "users", "TEACH1002")));
  await assertFails(updateDoc(doc(database("new-auth-user"), "users", "TEACH1002"), { uid: "new-auth-user", role: "admin", isRegistered: true }));
  await assertFails(setDoc(doc(admin, "_accountAccess", "new-auth-user"), { profileId: "TEACH1002", role: "teacher", active: true }));
});
test("server activation commits the invitation and private access mapping atomically using the real REST write shape", async () => {
  await environment.withSecurityRulesDisabled(async context => {
    await setDoc(doc(context.firestore(), "users", "TEACH1002"), { role: "teacher", providedEmail: "new@example.test", isRegistered: false, active: true });
  });
  const store = new FirestoreAdmin({});
  store.request = async (suffix, options = {}) => {
    const localSuffix = suffix.replaceAll("imars-db-a733b", projectId);
    const response = await fetch("http://127.0.0.1:58087/v1/projects/" + projectId + "/databases/(default)/" + localSuffix, {
      ...options, headers: { Authorization: "Bearer owner", "Content-Type": "application/json" },
      ...(options.body ? { body: options.body.replaceAll("imars-db-a733b", projectId) } : {})
    });
    if (response.status === 404) return null;
    if (!response.ok) throw Object.assign(new Error("Commit conflict " + response.status), { status: 409 });
    return response.json();
  };
  const call = () => accountAccess({ env: { ACCOUNT_ACCESS_ENABLED: "true" }, request: new Request("https://imars.example.test/api/account-access/claim", {
    method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer mocked-verified-id-token" }, body: '{"identifier":"TEACH1002"}'
  }) }, { store, fetcher: async () => Response.json({ users: [{ localId: "new-teacher", email: "new@example.test", emailVerified: true, displayName: "New Teacher" }] }) });
  const responses = await Promise.all([call(), call()]);
  assert.ok(responses.some(response => response.status === 200));
  assert.ok(responses.every(response => [200, 409].includes(response.status)));
  assert.equal((await getDoc(doc(database("new-teacher"), "users", "TEACH1002"))).data().uid, "new-teacher");
  await assertFails(updateDoc(doc(database("student-a"), "users", "TEACH1002"), { uid: "student-a" }));
});

test("migration bootstrap verifies the profile version atomically and cannot create access after a concurrent profile change", async () => {
  await environment.withSecurityRulesDisabled(async context => {
    await setDoc(doc(context.firestore(), "users", "0026271002"), { uid: "legacy-student", role: "student", classCode: "A" });
  });
  const store = new FirestoreAdmin({});
  store.request = async (suffix, options = {}) => {
    const response = await fetch("http://127.0.0.1:58087/v1/projects/" + projectId + "/databases/(default)/" + suffix, {
      ...options, headers: { Authorization: "Bearer owner", "Content-Type": "application/json" },
      ...(options.body ? { body: options.body.replaceAll("imars-db-a733b", projectId) } : {})
    });
    if (response.status === 404) return null;
    if (!response.ok) throw Error("Atomic bootstrap precondition rejected");
    return response.json();
  };
  const entries = [
    { uid: "admin-a", profileId: "ADMIN1000", role: "admin", active: true, authEmail: "admin-a@example.test" },
    { uid: "legacy-student", profileId: "0026271002", role: "student", active: true, authEmail: "legacy@example.test" }
  ];
  const lookup = async uid => ({ localId: uid, email: entries.find(entry => entry.uid === uid).authEmail });
  const stale = await prepareAccessBootstrap(entries, store, lookup);
  await environment.withSecurityRulesDisabled(async context => {
    await updateDoc(doc(context.firestore(), "users", "0026271002"), { displayName: "Changed during review" });
  });
  await assert.rejects(store.request("documents:commit", { method: "POST", body: JSON.stringify({ writes: stale.writes }) }));
  assert.equal(await store.get("_accountAccess/legacy-student"), null);
  const fresh = await prepareAccessBootstrap(entries, store, lookup);
  await store.request("documents:commit", { method: "POST", body: JSON.stringify({ writes: fresh.writes }) });
  assert.equal((await getDoc(doc(database("legacy-student"), "users", "0026271002"))).data().displayName, "Changed during review");
});
