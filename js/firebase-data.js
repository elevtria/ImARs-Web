import { getDoc as readDocument, getDocs as readCollection, onSnapshot as listen } from "https://www.gstatic.com/firebasejs/12.19.0/firebase-firestore.js";
import { startLoading, withLoading } from "./loading.js";
import { wrapFirestoreReads } from "./firebase-loading.js";

// Reads stay quiet by default. Main page fetches explicitly opt into the loader.
export * from "https://www.gstatic.com/firebasejs/12.19.0/firebase-firestore.js";
const loadingReads = wrapFirestoreReads(
  { getDoc: readDocument, getDocs: readCollection, onSnapshot: listen },
  { start: startLoading, run: withLoading }
);
export const getDocWithLoading = loadingReads.getDoc;
export const getDocsWithLoading = loadingReads.getDocs;
export const onSnapshotWithLoading = loadingReads.onSnapshot;
