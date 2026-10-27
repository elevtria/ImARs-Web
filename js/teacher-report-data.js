import { collection, getDocsWithLoading as getDocs, getDocs as quietDocs, getDoc as quietDoc, getFirestore, doc, query, where } from "./firebase-data.js";
import { getAuth } from "./firebase-auth.js";
import { encodeView, teacherViewCache } from "./view-cache.js";

export async function loadTeacherDashboard(db, user, readDocs = quietDocs, readDoc = quietDoc) {
  const profile = await readDocs(query(collection(db, "users"), where("uid", "==", user.uid)));
  if (profile.size !== 1 || profile.docs[0].data().role !== "teacher") {
    throw Object.assign(new Error("Teacher access required."), { code: "permission-denied" });
  }
  const teacher = profile.docs[0];
  const [classes, termSnap, curriculumSnap] = await Promise.all([
    readDocs(query(collection(db, "classes"), where("teacherId", "==", teacher.id))),
    readDoc(doc(db, "terms", "term_01")),
    readDocs(collection(db, "terms", "term_01", "lessons"))
  ]);
  const teacherName = teacher.data().displayName || "Teacher";
  if (classes.empty) return { teacherName, noClass: true };
  const classroom = classes.docs[0];
  const studentSnap = await readDocs(query(collection(db, "users"), where("role", "==", "student"), where("classCode", "==", classroom.id)));
  const reports = await Promise.all(studentSnap.docs.map(async studentDoc => ({
    studentDoc, lessonsSnap: await readDocs(collection(db, "users", studentDoc.id, "test_results", "term_01", "lessons"))
  })));
  return { teacherName, sectionName: classroom.data().SectionName || classroom.id, studentSnap, reports, termSnap, curriculumSnap };
}

export async function prepareDashboard(app, user) {
  const auth = getAuth(app);
  if (!user?.uid || user.role !== "teacher" || auth.currentUser?.uid !== user.uid) return;
  const cache = teacherViewCache();
  cache.setOwner(user.uid);
  const version = cache.version();
  const data = await loadTeacherDashboard(getFirestore(app), user);
  if (auth.currentUser?.uid === user.uid) cache.put(user.uid, "dashboard", encodeView(data), version);
}

// All independent reads enter the shared pool (at most eight in flight).
// Promise.all preserves section, student, and term order for rendering.
export function loadClassReports(db, classDocs, terms, read = getDocs) {
  return Promise.all(classDocs.map(async classDoc => {
    const roster = await read(query(collection(db, "users"), where("role", "==", "student"), where("classCode", "==", classDoc.id)));
    const students = await Promise.all(roster.docs.map(async studentDoc => ({
      studentDoc,
      results: await Promise.all(terms.map(async termId => ({
        termId,
        lessonsSnap: await read(collection(db, "users", studentDoc.id, "test_results", termId, "lessons"))
      })))
    })));
    return { classDoc, students };
  }));
}
