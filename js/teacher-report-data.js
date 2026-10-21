import { collection, getDocsWithLoading as getDocs, query, where } from "./firebase-data.js";

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
