import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import { createReadPool } from "../js/data-read-pool.js";
import { wrapFirestoreReads } from "../js/firebase-loading.js";

test("student changes refresh matching roster listeners without re-reading unrelated schedules or settings", async () => {
  const paths = [];
  const context = vm.createContext({ createReadPool, wrapFirestoreReads, performance, queueMicrotask,
    invalidateTeacherViews() {}, startLoading: () => () => {}, withLoading: action => action(),
    setTimeout: () => 0, clearTimeout() {},
    window: { location: { pathname: "/student-records.html" }, addEventListener() {}, removeEventListener() {} },
    document: { visibilityState: "visible", addEventListener() {}, removeEventListener() {} },
    webRequest: async (_url, body) => {
      if (body.action !== "reads") return {};
      return { results: body.reads.map(read => {
        paths.push(read.reference.path);
        return read.action === "get" ? { document: { path: read.reference.path, id: "value", data: {} } } : { documents: [] };
      }) };
    }
  });
  const source = readFileSync(new URL("../js/firebase-data.js", import.meta.url), "utf8").replace(/^import[^\n]+\r?\n/gm, "").replace(/^export /gm, "");
  const api = vm.runInContext(source + "\n({onSnapshot,updateDoc});", context);
  const stops = [
    {kind:"query",path:"users"}, {kind:"document",path:"users/other-student"},
    {kind:"document",path:"webSettings/schoolYear"}, {kind:"query",path:"terms/term_01/lessons"}
  ].map(ref => api.onSnapshot(ref, () => {}));
  await new Promise(setImmediate); paths.length = 0;
  await api.updateDoc({kind:"document",path:"users/student-a"}, {active:false});
  await new Promise(setImmediate);
  assert.deepEqual(paths, ["users"]);
  stops.forEach(stop => stop());
});

test("successful Firestore writes and committed batches invalidate views; denied writes keep them", async () => {
  let invalidated = 0, rejectWrite = true;
  const operation = async () => { if (rejectWrite) throw new Error("permission-denied"); return "saved"; };
  const context = vm.createContext({
    createReadPool, wrapFirestoreReads, performance,
    webRequest: operation, crypto,
    readDocument: async () => ({}), readCollection: async () => ({}), listen: () => () => {},
    queryEqual: (a, b) => a === b, refEqual: (a, b) => a === b,
    startLoading: () => () => {}, withLoading: operation => operation(),
    writeDocument: operation, editDocument: operation, removeDocument: operation, addDocument: operation,
    createBatch: () => ({ update() { return this; }, commit: operation }),
    invalidateTeacherViews: () => { invalidated++; }
  });
  const source = readFileSync(new URL("../js/firebase-data.js", import.meta.url), "utf8")
    .replace(/^import[^\n]+\r?\n/gm, "").replace(/^export \* from[^\n]+\r?\n/gm, "").replace(/^export /gm, "");
  const api = vm.runInContext(source + "\n({setDoc,updateDoc,deleteDoc,addDoc,writeBatch});", context);
  await assert.rejects(api.setDoc({path:"users/student"}, {}), /permission-denied/);
  const batch = api.writeBatch(); assert.equal(batch.update({path:"users/student"}, {}), batch);
  await assert.rejects(batch.commit(), /permission-denied/);
  assert.equal(invalidated, 0);
  rejectWrite = false;
  for (const write of [api.setDoc, api.updateDoc, api.deleteDoc, api.addDoc]) await write({path:"users/student"}, {});
  await api.writeBatch().update({path:"users/student"}, {}).commit();
  assert.equal(invalidated, 5);
});
