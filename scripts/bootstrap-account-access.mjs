import { readFile } from "node:fs/promises";
import { FirestoreAdmin, serviceToken } from "../server/firestore-admin.js";
import { prepareAccessBootstrap } from "../server/account-bootstrap.js";

const args = process.argv.slice(2), apply = args.includes("--apply");
const file = args.find(arg => !arg.startsWith("--"));
if (!file || args.some(arg => arg.startsWith("--") && arg !== "--apply")) throw Error("Usage: node scripts/bootstrap-account-access.mjs <reviewed-manifest.json> [--apply]");
const env = { FIREBASE_SERVICE_ACCOUNT_JSON: process.env.FIREBASE_SERVICE_ACCOUNT_JSON };
if (!env.FIREBASE_SERVICE_ACCOUNT_JSON) throw Error("Provide FIREBASE_SERVICE_ACCOUNT_JSON through the local environment. Never paste it in chat or commit it.");
const store = new FirestoreAdmin(env);
const lookup = async uid => {
  const token = await serviceToken(env);
  const response = await fetch("https://identitytoolkit.googleapis.com/v1/projects/imars-db-a733b/accounts:lookup", {
    method: "POST", headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
    body: JSON.stringify({ localId: [uid] }), signal: AbortSignal.timeout(10_000)
  });
  if (!response.ok) throw Error("Firebase Authentication lookup failed; no records were written.");
  return (await response.json()).users?.[0];
};
const plan = await prepareAccessBootstrap(JSON.parse(await readFile(file, "utf8")), store, lookup);
console.log(`Validated ${plan.approved.length} reviewed accounts; ${plan.writes.length / 2} new private access bindings.`);
if (!apply) {
  console.log("Read-only check completed. No records were written. Review the cutover instructions before using --apply.");
} else {
  // Keep each verify/create pair in one transaction, below Firestore's limit.
  // Completed batches are idempotent if a later batch fails and the tool is rerun.
  for (let offset = 0; offset < plan.writes.length; offset += 200) {
    await store.request("documents:commit", { method: "POST", body: JSON.stringify({ writes: plan.writes.slice(offset, offset + 200) }) });
  }
  console.log("Private access bindings created. No user profiles or Firebase Authentication accounts were changed.");
}
