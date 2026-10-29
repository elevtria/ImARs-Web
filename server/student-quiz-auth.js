import { stateCall } from "./web-auth.js";

const publicFirebaseKey = "AIzaSyBwH8D-mJSpjqu_C7Y7e7ljCjSZiO7FTm0";
export const quizFailure = (code, status = 403, message = "This quiz is no longer available.") => Object.assign(new Error(message), { code, status });
export const validPart = value => typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value);
export const activeProfile = value => value && value.active !== false && !["inactive", "disabled", "deleted", "archived"].includes(String(value.status || "").toLowerCase());

export async function authenticateStudent(request, _env, store, { fetcher = fetch, now = Date.now() } = {}) {
  const token = request.headers.get("Authorization")?.match(/^Bearer ([A-Za-z0-9_.-]{1,8192})$/)?.[1];
  const denied = () => quizFailure("UNAUTHENTICATED", 401, "Please sign in again.");
  if (!token) throw denied();
  let claims, header;
  try {
    const parts = token.split(".");
    if (parts.length !== 3) throw denied();
    const decode = value => JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(value.replace(/-/g, "+").replace(/_/g, "/")), char => char.charCodeAt(0))));
    header = decode(parts[0]); claims = decode(parts[1]);
  } catch { throw denied(); }
  const time = Math.floor(now / 1000);
  if (header.alg !== "RS256" || !header.kid || claims.aud !== "imars-db-a733b" || claims.iss !== "https://securetoken.google.com/imars-db-a733b" ||
      !validPart(claims.sub) || !Number.isSafeInteger(claims.exp) || claims.exp <= time || !Number.isSafeInteger(claims.iat) || claims.iat > time ||
      !Number.isSafeInteger(claims.auth_time) || claims.auth_time > time || claims.email_verified !== true) throw denied();
  // Google verifies the signature and ID token. Decoding claims above alone never authenticates a caller.
  const response = await fetcher("https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=" + publicFirebaseKey, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ idToken: token }), signal: AbortSignal.timeout(10_000)
  });
  if (!response.ok) throw response.status >= 500 ? quizFailure("SERVICE_UNAVAILABLE", 503) : denied();
  const user = (await response.json()).users?.[0];
  if (!user || user.localId !== claims.sub || user.disabled || user.emailVerified !== true) throw denied();
  // The privileged record supplies revocation time (validSince), not client claims.
  const identity = await store.identity(claims.sub);
  if (!identity || identity.disabled || identity.emailVerified !== true || Number(identity.validSince || 0) > claims.auth_time) throw denied();
  return { uid: claims.sub, email: String(identity.email || "").toLowerCase() };
}

export async function studentContext(identity, env, store) {
  let id;
  const access = await store.get("_accountAccess/" + identity.uid);
  if (access) {
    if (access.data.active !== true || access.data.role !== "student" || !validPart(access.data.profileId) ||
        String(access.data.authEmail || "").toLowerCase() !== identity.email) throw quizFailure("SCOPE_CHANGED");
    id = access.data.profileId;
  } else {
    if (env.ACCOUNT_ACCESS_ENABLED === "true") throw quizFailure("SCOPE_CHANGED");
    const rows = await store.query("users", { filters: [{ field: "uid", value: identity.uid }], limit: 2 });
    if (rows.length !== 1) throw quizFailure("SCOPE_CHANGED");
    id = rows[0].id;
  }
  if (!validPart(id)) throw quizFailure("SCOPE_CHANGED");
  const profile = (await store.get("users/" + id))?.data;
  if (!activeProfile(profile) || profile.uid !== identity.uid || profile.role !== "student" || !validPart(profile.classCode)) throw quizFailure("SCOPE_CHANGED");
  const section = (await store.get("classes/" + profile.classCode))?.data;
  if (!activeProfile(section) || !validPart(section.teacherId) || (profile.teacherId && profile.teacherId !== section.teacherId)) throw quizFailure("SCOPE_CHANGED");
  const teacher = (await store.get("users/" + section.teacherId))?.data;
  if (!activeProfile(teacher) || teacher.role !== "teacher" || !validPart(teacher.uid)) throw quizFailure("SCOPE_CHANGED");
  const teacherIdentity = await store.identity(teacher.uid);
  if (!teacherIdentity || teacherIdentity.disabled || teacherIdentity.emailVerified !== true) throw quizFailure("SCOPE_CHANGED");
  const teacherAccess = await store.get("_accountAccess/" + teacher.uid);
  if ((env.ACCOUNT_ACCESS_ENABLED === "true" && !teacherAccess) || (teacherAccess && (teacherAccess.data.active !== true || teacherAccess.data.profileId !== section.teacherId || teacherAccess.data.role !== "teacher"))) throw quizFailure("SCOPE_CHANGED");
  return { context: { uid: identity.uid, studentId: id, sectionId: profile.classCode, teacherProfileId: section.teacherId, teacherUid: teacher.uid },
    teacherName: String(teacher.displayName || teacher.fullName || "Your teacher").slice(0, 200) };
}

export async function quizRate(env, uid) {
  if (!env.WEB_LOGIN_STATE) throw quizFailure("SERVICE_UNAVAILABLE", 503);
  const result = await stateCall(env, "student-quizzes:" + uid, "rate");
  if (!result.ok) throw quizFailure(result.status === 429 ? "RATE_LIMITED" : "SERVICE_UNAVAILABLE", result.status === 429 ? 429 : 503);
}
