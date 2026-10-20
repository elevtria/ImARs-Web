import { getDoc as readDocument, getDocs as readCollection, onSnapshot as listen, queryEqual, refEqual, setDoc as writeDocument, updateDoc as editDocument, deleteDoc as removeDocument, addDoc as addDocument, writeBatch as createBatch } from "https://www.gstatic.com/firebasejs/12.19.0/firebase-firestore.js";
import { startLoading, withLoading } from "./loading.js";
import { wrapFirestoreReads } from "./firebase-loading.js";
import { createReadPool } from "./data-read-pool.js";
import { invalidateTeacherViews } from "./view-cache.js";

// Reads stay quiet by default. Main page fetches explicitly opt into the loader.
export * from "https://www.gstatic.com/firebasejs/12.19.0/firebase-firestore.js";
const pool = createReadPool({ equal: (kind, a, b) => kind === "document" ? refEqual(a, b) : queryEqual(a, b) });
export const getDoc = reference => pool.read("document", reference, () => readDocument(reference));
export const getDocs = reference => pool.read("query", reference, () => readCollection(reference));
export const getReadMetrics = pool.metrics;
const loadingReads = wrapFirestoreReads(
  { getDoc, getDocs, onSnapshot: listen },
  { start: startLoading, run: withLoading }
);
export const getDocWithLoading = loadingReads.getDoc;
export const getDocsWithLoading = loadingReads.getDocs;
export const onSnapshotWithLoading = loadingReads.onSnapshot;

const invalidateAfter = operation => async (...args) => {
  const result = await operation(...args);
  invalidateTeacherViews();
  return result;
};
export const setDoc = invalidateAfter(writeDocument);
export const updateDoc = invalidateAfter(editDocument);
export const deleteDoc = invalidateAfter(removeDocument);
export const addDoc = invalidateAfter(addDocument);
export function writeBatch(...args) {
  const batch = createBatch(...args);
  const commit = batch.commit.bind(batch);
  batch.commit = invalidateAfter(commit);
  return batch;
}
