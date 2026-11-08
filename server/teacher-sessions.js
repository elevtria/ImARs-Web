// Shared only by trusted backends. Firestore rules deny client access to this
// existing private namespace; browser and mobile never write session ownership.
const enabled = env => env.TEACHER_SESSION_SYNC_ENABLED === "true";
const valid = value => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const random = () => Array.from(crypto.getRandomValues(new Uint8Array(32)), byte => byte.toString(16).padStart(2, "0")).join("");
const path = account => {
  if (account.role !== "teacher" || !/^[A-Za-z0-9_-]{1,128}$/.test(account.uid) || !/^[A-Za-z0-9_-]{1,64}$/.test(account.id)) throw new Error("Invalid teacher session owner");
  return `_accountAccess/${account.uid}/sessions/teacher`;
};
const digest = async receipt => Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(receipt))), byte => byte.toString(16).padStart(2, "0")).join("");
const owned = (data, account) => data?.schemaVersion === 1 && data.uid === account.uid && data.profileId === account.id;

export async function openTeacherSession(env, store, account, platform, receipt) {
  if (!enabled(env) || account.role !== "teacher") return undefined;
  if (!["web", "mobile"].includes(platform) || (platform === "mobile" && !valid(receipt))) throw new Error("Invalid teacher session");
  const key = path(account);
  for (let attempt = 0; attempt < 5; attempt++) {
    const previous = await store.get(key);
    // Existing website tabs may coexist. A mobile takeover always changes the
    // epoch, so an old website cookie can never revive after another web login.
    const epoch = platform === "web" && owned(previous?.data, account) && previous.data.platform === "web" && valid(previous.data.epoch)
      ? previous.data.epoch : random();
    const data = { schemaVersion: 1, uid: account.uid, profileId: account.id, platform, epoch,
      mobileReceiptHash: platform === "mobile" ? await digest(receipt) : "", updatedAt: { $type: "serverTimestamp" } };
    try {
      await store.commit([{ path: key, operation: "set", data, ...(previous ? { updateTime: previous.updateTime } : {}) }]);
      return epoch;
    } catch (error) { if (error.status !== 409 || attempt === 4) throw error; }
  }
}

export async function checkTeacherSession(env, store, account, platform, credential) {
  if (!enabled(env) || account.role !== "teacher") return true;
  if (!valid(credential)) return false;
  const data = (await store.get(path(account)))?.data;
  return owned(data, account) && data.platform === platform &&
    (platform === "web" ? data.epoch === credential : data.mobileReceiptHash === await digest(credential));
}
