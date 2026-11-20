import { securityAudit } from "./security-audit.js";

const recoveryMessage = "If that Teacher ID belongs to an eligible account, a password reset link will be sent to its verified email. Check your inbox and spam folder. Wait five minutes before requesting another link.";
const active = data => data?.active !== false && !["inactive", "disabled", "archived", "deleted"].includes(String(data?.status || "").toLowerCase());

// Reuse Firebase's hosted, single-use reset flow. Never return its response,
// email address, reset code or link to the caller.
export async function sendPasswordRecoveryEmail(fetcher, email) {
  const response = await fetcher("https://identitytoolkit.googleapis.com/v1/accounts:sendOobCode?key=AIzaSyBwH8D-mJSpjqu_C7Y7e7ljCjSZiO7FTm0", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ requestType: "PASSWORD_RESET", email }), signal: AbortSignal.timeout(10_000)
  });
  return response.ok;
}

async function recoverTeacher(store, identifier, fetcher, now) {
  let transaction = false;
  const actor = { id: "SELF_SERVICE", role: "public" };
  try {
    const profile = await store.get("users/" + identifier);
    if (profile?.data.role !== "teacher" || !active(profile.data) || !profile.data.uid) return;
    const user = await store.identity(profile.data.uid);
    if (user?.localId !== profile.data.uid || user.disabled || user.emailVerified !== true ||
        typeof user.email !== "string" || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(user.email)) return;
    await store.begin(); transaction = true;
    const path = "webSettings/security/resetLimits/" + identifier;
    const [current, limit] = await Promise.all([store.get("users/" + identifier), store.get(path)]);
    if (current?.data.uid !== profile.data.uid || current.data.role !== "teacher" || !active(current.data) || Number(limit?.data.until) > now) return;
    await store.commit([
      { operation: "set", path, ...(limit ? { updateTime: limit.updateTime } : {}), data: { until: now + 300_000 } },
      securityAudit(actor, "password-reset-requested", identifier, "Teacher login recovery request", now)
    ]); transaction = false;
    let sent = false;
    try { sent = await sendPasswordRecoveryEmail(fetcher, user.email); }
    finally { await store.commit([securityAudit(actor, sent ? "password-reset-sent" : "password-reset-failed", identifier, "Teacher login recovery request")]); }
  } finally {
    if (transaction) await store.rollback();
  }
}

export async function teacherPasswordRecovery({ request, env, body, store, callState, waitUntil, fetcher = fetch, now = Date.now() }) {
  if (typeof body.identifier !== "string" || !/^TEACH\d{4,10}$/i.test(body.identifier.trim())) {
    return Response.json({ error: "Enter your Teacher ID, for example TEACH1000." }, { status: 400, headers: { "Cache-Control": "no-store" } });
  }
  const identifier = body.identifier.trim().toUpperCase();
  // These counters are independent of sign-in attempts and run for unknown IDs
  // too. Recovery requests never lock an account or start a signed-in session.
  for (const name of [request.headers.get("CF-Connecting-IP") ? "recovery-ip:" + request.headers.get("CF-Connecting-IP") : null,
    "recovery-id:" + identifier].filter(Boolean)) {
    const rate = await callState(env, name, "generation-rate");
    if (!rate.ok && rate.status !== 429) throw new Error("Recovery request protection is unavailable");
    if (!rate.ok) return Response.json({ error: "Too many recovery requests. Please wait a minute and try again." },
      { status: 429, headers: { "Cache-Control": "no-store", "Retry-After": "60" } });
  }
  // Account lookup and delivery run off the response path, giving all valid IDs
  // the same public response without exposing lookup/delivery timing.
  const job = recoverTeacher(store, identifier, fetcher, now).catch(() => {
    console.warn(JSON.stringify({ event: "teacher-password-recovery-unavailable" }));
  });
  if (waitUntil) waitUntil(job);
  else await job;
  return Response.json({ ok: true, message: recoveryMessage }, { headers: { "Cache-Control": "no-store" } });
}
