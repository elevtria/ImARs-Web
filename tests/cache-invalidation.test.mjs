import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import { createReadPool } from "../js/data-read-pool.js";
import { wrapFirestoreReads } from "../js/firebase-loading.js";

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
