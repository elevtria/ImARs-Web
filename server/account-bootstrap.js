import { encodeFields } from "./firestore-admin.js";

export function validateAccessManifest(entries) {
  if (!Array.isArray(entries) || !entries.length || entries.length > 5000) throw Error("Use a reviewed, non-empty account manifest (maximum 5,000 accounts).");
  const uids = new Set(), ids = new Set(), emails = new Set();
  const result = entries.map(entry => {
    if (!entry || typeof entry.uid !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(entry.uid) ||
        typeof entry.profileId !== "string" || !/^[A-Z0-9_-]{1,64}$/.test(entry.profileId) ||
        !["student", "teacher", "admin"].includes(entry.role) || typeof entry.active !== "boolean" ||
        typeof entry.authEmail !== "string" || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(entry.authEmail)) throw Error("Invalid account manifest entry.");
    const authEmail = entry.authEmail.trim().toLowerCase();
    if (uids.has(entry.uid) || ids.has(entry.profileId) || emails.has(authEmail)) throw Error("Duplicate UID, school ID or email in the account manifest.");
    uids.add(entry.uid); ids.add(entry.profileId); emails.add(authEmail);
    return { uid: entry.uid, profileId: entry.profileId, role: entry.role, active: entry.active, authEmail };
  });
  if (!result.some(entry => entry.role === "admin" && entry.active)) throw Error("The manifest must retain an active administrator.");
  return result;
}

export async function prepareAccessBootstrap(entries, store, lookupIdentity) {
  const approved = validateAccessManifest(entries), writes = [];
  for (const entry of approved) {
    const profile = await store.get("users/" + entry.profileId);
    if (!profile || profile.data.uid !== entry.uid || (profile.data.role || "student") !== entry.role) throw Error("A profile does not match its reviewed UID and role.");
    const unique = await store.findUser(entry.uid);
    if (!unique || unique.id !== entry.profileId) throw Error("A Firebase UID is missing or duplicated across school profiles.");
    const identity = await lookupIdentity(entry.uid);
    if (!identity || identity.localId !== entry.uid || String(identity.email || "").toLowerCase() !== entry.authEmail || (identity.disabled && entry.active)) {
      throw Error("A Firebase Authentication account does not match the reviewed manifest.");
    }
    const access = await store.get("_accountAccess/" + entry.uid);
    const data = { profileId: entry.profileId, role: entry.role, active: entry.active, authEmail: entry.authEmail };
    if (access) {
      if (access.data.profileId !== entry.profileId || access.data.role !== entry.role || access.data.authEmail !== entry.authEmail || access.data.active !== entry.active) {
        throw Error("An existing access binding differs from the reviewed manifest. Review it separately.");
      }
      continue;
    }
    // Verify the profile's exact version in the same atomic commit as its
    // corresponding binding. Never silently repair or overwrite user records.
    writes.push({ verify: store.name("users/" + entry.profileId), currentDocument: { updateTime: profile.updateTime } },
      { update: { name: store.name("_accountAccess/" + entry.uid), fields: encodeFields(data) }, currentDocument: { exists: false } });
  }
  return { approved, writes };
}
