import { appStore } from "./supabase-app-store.js";
import { requireStaff, stateCall, readJson } from "./web-auth.js";
import { transferredRosterWrites } from "./web-data.js";
import { auditCollection, securityAudit } from "./security-audit.js";
import { confirmAdministratorPassword } from "./admin-reauth.js";

const fail = (message, status = 400) => Object.assign(new Error(message), { status });
const validId = value => typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value);
const active = data => data?.active !== false && !["inactive", "disabled", "archived", "deleted"].includes(String(data?.status || "").toLowerCase());
const json = (body, status = 200) => Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
const roleFilter = role => [{ field: "role", op: "==", value: role }];

export { confirmAdministratorPassword };

export async function adminSecurity({ request, env }, { store, authenticate = requireStaff, fetcher = fetch, callState = stateCall } = {}) {
  let transaction = false;
  try {
    if (request.method !== "POST") throw fail("Use POST.", 405);
    if (!request.headers.get("Content-Type")?.startsWith("application/json")) throw fail("Use JSON.", 415);
    store ??= appStore(env);
    const actor = await authenticate(request, env, store);
    if (actor.role !== "admin") throw fail("Administrator access is required.", 403);
    const body = await readJson(request, 8192);
    if (!body || typeof body !== "object" || Array.isArray(body)) throw fail("Invalid request.");
    if (body.action === "directory") {
      const [teachers, classes, students] = await Promise.all([
        store.query("users", { filters: roleFilter("teacher"), fieldPaths: ["fullName", "displayName", "active", "status"] }),
        store.query("classes", { fieldPaths: ["SectionName", "sectionName", "teacherId", "active", "status"] }),
        store.query("users", { filters: roleFilter("student"), fieldPaths: ["classCode", "active", "status"] })
      ]);
      return json({ self: { id: actor.id, name: actor.profile?.fullName || actor.profile?.displayName || "Administrator" },
        teachers: teachers.map(({ id, data }) => ({ id, name: data.fullName || data.displayName || id, active: active(data) })),
        sections: classes.filter(({ data }) => active(data)).map(({ id, data }) => ({ id, name: data.SectionName || data.sectionName || id,
          teacherId: data.teacherId || "", students: students.filter(row => row.data.classCode === id && active(row.data)).length })) });
    }
    if (body.action === "audit") {
      if (body.cursor && !/^[0-9]{13}_[a-f0-9]{32}$/.test(body.cursor)) throw fail("Invalid activity cursor.");
      const rows = await store.query(auditCollection, { limit: 26, ...(body.cursor ? { after: body.cursor } : {}) });
      return json({ entries: rows.slice(0, 25).map(({ id, data }) => ({ id, actorId: data.actorId, action: data.action,
        targetId: data.targetId, details: data.details, at: data.at })), cursor: rows.length > 25 ? rows[24].id : null });
    }
    if (!["reset-password", "end-sessions", "transfer-section"].includes(body.action)) throw fail("Unknown account operation.");
    await confirmAdministratorPassword(env, store, actor, body.password, callState);
    await store.begin(); transaction = true;
    const current = await authenticate(request, env, store);
    if (current.role !== "admin" || current.uid !== actor.uid) throw fail("Administrator access is required.", 403);
    if (body.action === "transfer-section") {
      if (!validId(body.sectionId) || !validId(body.teacherId) || (!validId(body.previousTeacherId) && body.previousTeacherId !== "")) throw fail("Choose a section and teacher.");
      const [section, teacher, classes] = await Promise.all([store.get("classes/" + body.sectionId), store.get("users/" + body.teacherId), store.query("classes")]);
      if (!section || !active(section.data) || teacher?.data.role !== "teacher" || !active(teacher.data)) throw fail("Choose an active section and teacher.");
      if ((section.data.teacherId || "") !== body.previousTeacherId) throw fail("The section assignment changed. Refresh and try again.", 409);
      if (body.teacherId === body.previousTeacherId) throw fail("Choose a different teacher.");
      const writes = [{ operation: "update", path: "classes/" + body.sectionId, updateTime: section.updateTime, data: { teacherId: body.teacherId } },
        ...await transferredRosterWrites(store, [body], { authoritative: true })];
      for (const id of [body.previousTeacherId, body.teacherId].filter(Boolean)) {
        const row = id === body.teacherId ? teacher : await store.get("users/" + id);
        if (row?.data.role !== "teacher") throw fail("The existing teacher assignment needs review.", 409);
        const sections = classes.filter(row => row.id === body.sectionId ? id === body.teacherId : row.data.teacherId === id)
          .map(row => row.data.SectionName || row.data.sectionName || row.id);
        writes.push({ operation: "update", path: "users/" + id, updateTime: row.updateTime, data: { sections } });
      }
      writes.push(securityAudit(actor, "section-transferred", body.sectionId, `${body.previousTeacherId} → ${body.teacherId}`));
      if (writes.length > 100) throw fail("This section is too large for a single safe transfer. Contact website maintenance; no assignments were changed.", 409);
      await store.commit(writes); transaction = false;
      return json({ ok: true, message: "Section and roster assignment updated. Existing scores and account status were preserved." });
    }
    if (!validId(body.targetId)) throw fail("Choose an account.");
    const target = await store.get("users/" + body.targetId);
    if (!target || !(target.data.role === "teacher" || (body.targetId === actor.id && target.data.role === "admin")) || !validId(target.data.uid)) throw fail("This account cannot be managed here.", 403);
    const uid = target.data.uid;
    if (body.action === "reset-password") {
      const user = await store.identity(uid);
      if (!active(target.data) || !user?.emailVerified || !user.email || user.disabled) throw fail("Recovery requires an active account with a verified Firebase email. Contact school support to verify ownership first.", 409);
      const path = "webSettings/security/resetLimits/" + body.targetId;
      const limit = await store.get(path);
      if (Number(limit?.data.until) > Date.now()) throw fail("A recovery email was recently requested. Wait five minutes before retrying.", 429);
      await store.commit([{ operation: "set", path, ...(limit ? { updateTime: limit.updateTime } : {}), data: { until: Date.now() + 300_000 } },
        securityAudit(actor, "password-reset-requested", body.targetId)]); transaction = false;
      const response = await fetcher("https://identitytoolkit.googleapis.com/v1/accounts:sendOobCode?key=AIzaSyBwH8D-mJSpjqu_C7Y7e7ljCjSZiO7FTm0", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ requestType: "PASSWORD_RESET", email: user.email }), signal: AbortSignal.timeout(10_000)
      });
      await store.commit([securityAudit(actor, response.ok ? "password-reset-sent" : "password-reset-failed", body.targetId)]);
      if (!response.ok) throw fail("The recovery email could not be sent. Contact school support or retry after five minutes.", 503);
      return json({ ok: true, message: "Firebase accepted the recovery email request for the account’s verified address. Check the inbox and spam folder." });
    }
    // Invalidate existing portal sessions, including the shared mobile teacher receipt.
    const sessionPath = `_accountAccess/${uid}/sessions/teacher`;
    const previous = target.data.role === "teacher" ? await store.get(sessionPath) : null;
    const writes = [securityAudit(actor, "portal-sessions-requested", body.targetId)];
    if (previous) writes.push({ operation: "update", path: sessionPath, updateTime: previous.updateTime,
      data: { epoch: crypto.randomUUID().replaceAll("-", "") + crypto.randomUUID().replaceAll("-", ""), mobileReceiptHash: "", updatedAt: { $type: "serverTimestamp" } } });
    await store.commit(writes); transaction = false;
    for (const action of ["logout", "mobile-revoke"]) {
      const result = await callState(env, "account:" + uid, action, {});
      if (!result.ok) throw fail("Some portal sessions could not be ended. Retry the operation.", 503);
    }
    await store.commit([securityAudit(actor, "portal-sessions-ended", body.targetId)]);
    return json({ ok: true, message: "Portal sessions ended. The account will need to sign in again on its next protected request." });
  } catch (error) {
    if (transaction) await store.rollback().catch(() => {});
    const status = [400, 401, 403, 405, 409, 413, 415, 429].includes(error.status) ? error.status : 503;
    return json({ error: status === 503 && error.status !== 503 ? "Account services are temporarily unavailable. Please retry." : error.message,
      code: status === 403 ? "permission-denied" : status === 401 ? "unauthenticated" : "unavailable" }, status);
  }
}
