const encoder = new TextEncoder();
const signaturePattern = /^[a-f0-9]{64}$/;
export const quizJobIdPattern = /^[a-f0-9-]{36}$/;
export const quizJobLifetime = 60 * 60_000;

async function jobKey(secret) {
  return crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}

export async function signQuizJob(secret, payload) {
  const body = JSON.stringify(payload);
  const signature = await crypto.subtle.sign("HMAC", await jobKey(secret), encoder.encode("imars-quiz-job-v1\n" + body));
  return { body, signature: Array.from(new Uint8Array(signature), byte => byte.toString(16).padStart(2, "0")).join("") };
}

export async function verifyQuizJob(secret, signature, body, now = Date.now()) {
  if (typeof secret !== "string" || secret.length < 32 || !signaturePattern.test(signature)) return null;
  const bytes = Uint8Array.from(signature.match(/../g), byte => parseInt(byte, 16));
  if (!await crypto.subtle.verify("HMAC", await jobKey(secret), bytes, encoder.encode("imars-quiz-job-v1\n" + body))) return null;
  const payload = JSON.parse(body);
  return Number.isSafeInteger(payload.executeBy) && now <= payload.executeBy && payload.executeBy <= now + 5 * 60_000 ? payload : null;
}

export function quizJobObject(env, actor) {
  return env.QUIZ_GENERATION_JOBS.get(env.QUIZ_GENERATION_JOBS.idFromName(JSON.stringify([actor.uid, actor.id])));
}

export function quizJobResponse(body, status = 200) {
  return Response.json(body, { status, headers: { "Cache-Control": "private, no-store" } });
}
