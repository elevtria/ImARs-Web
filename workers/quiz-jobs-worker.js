import { quizExecutionObject, quizJobIdPattern, quizJobLifetime, quizJobResponse as json } from "../server/quiz-background.js";

const failed = "Quiz generation could not finish. Please try again.";
const deliveryFailed = { status: "failed", errorCode: "JOB_DELIVERY_FAILED",
  error: "The server could not finish this quiz. Please try generating it again." };
const active = job => ["queued", "running"].includes(job?.status);

export class QuizGenerationJob {
  constructor(state, env) {
    this.storage = state.storage;
    this.env = env;
    this.callback = new URL("/api/run-quiz-job", env.QUIZ_JOB_CALLBACK_ORIGIN).href;
  }

  async fetch(request) {
    const now = Date.now();
    const path = new URL(request.url).pathname;
    if (path === "/execution-result" && request.method === "GET") {
      const execution = await this.storage.get("execution");
      return json(execution && execution.expiresAt > now ? execution : { status: "none" });
    }
    if (["/claim-execution", "/finish-execution"].includes(path) && request.method === "POST") {
      const body = await request.json();
      if (!quizJobIdPattern.test(body.id)) return json({ error: failed }, 400);
      return this.storage.transaction(async txn => {
        const execution = await txn.get("execution");
        if (path === "/claim-execution") {
          if (execution || !Number.isSafeInteger(body.executeBy) || body.executeBy < now || body.executeBy > now + 5 * 60_000) return json({ error: failed }, 409);
          await txn.put("execution", { id: body.id, status: "running", expiresAt: now + quizJobLifetime });
          await txn.setAlarm(now + quizJobLifetime);
        } else {
          if (execution?.id === body.id && execution.status === "complete") return json({ ok: true });
          if (execution?.id !== body.id || execution.status !== "running" || !Number.isInteger(body.result?.status) ||
              body.result.status < 200 || body.result.status > 599 || !body.result.body || typeof body.result.body !== "object") return json({ error: failed }, 409);
          await txn.put("execution", { ...execution, status: "complete", result: body.result });
        }
        return json({ ok: true });
      });
    }
    if (request.method === "POST" && new URL(request.url).pathname === "/claim") {
      const { id } = await request.json();
      return this.storage.transaction(async txn => {
        const job = await txn.get("job");
        if (job?.id !== id || job.status !== "running" || job.claimed) return json({ error: failed }, 409);
        await txn.put("job", { ...job, claimed: true });
        return json({ ok: true });
      });
    }
    if (request.method === "GET") {
      const job = await this.storage.get("job");
      if (!job || job.expiresAt <= now) return json({ status: "none" });
      const { id, status, details, questions, error, errorCode } = job;
      return json({ id, status, details, questions, error, errorCode });
    }
    if (request.method === "POST") {
      const { id, details, callback } = await request.json();
      if (!quizJobIdPattern.test(id) || !details || !callback) return json({ error: failed }, 400);
      return this.storage.transaction(async txn => {
        const current = await txn.get("job");
        if (current?.expiresAt > now && (active(current) || current.status === "complete")) {
          return json({ id: current.id, status: current.status }, 409);
        }
        await txn.put("job", { id, details, callback, status: "queued", expiresAt: now + quizJobLifetime });
        await txn.setAlarm(now);
        return json({ id, status: "queued" }, 202);
      });
    }
    if (request.method === "DELETE") {
      const id = new URL(request.url).searchParams.get("id");
      await this.storage.transaction(async txn => {
        const job = await txn.get("job");
        if (job?.id !== id || active(job)) return;
        await txn.delete("job");
        await txn.deleteAlarm();
      });
      return json({ ok: true });
    }
    return json({ error: "Method not allowed." }, 405);
  }

  async alarm() {
    const now = Date.now();
    const job = await this.storage.transaction(async txn => {
      const current = await txn.get("job");
      if (!current) { await txn.delete("execution"); return null; }
      if (current.expiresAt <= now) {
        await txn.delete("job");
        return null;
      }
      if (current.status === "running") {
        return { ...current, recover: true };
      }
      if (current.status !== "queued") {
        await txn.setAlarm(current.expiresAt);
        return null;
      }
      await txn.put("job", { ...current, status: "running", startedAt: now });
      await txn.setAlarm(now + 120_000);
      return { ...current, startedAt: now };
    });
    if (!job) return;
    let result;
    try {
      const response = job.recover ? null : await fetch(this.callback, {
        method: "POST", redirect: "error", signal: AbortSignal.timeout(95_000),
        headers: { "Content-Type": "application/json", "X-Imars-Quiz-Signature": job.callback.signature },
        body: job.callback.body
      });
      const body = await response?.json().catch(() => null);
      result = response?.ok && Array.isArray(body?.questions) && body.questions.length
        ? { status: "complete", questions: body.questions }
        : typeof body?.error === "string" && body.error !== failed && ![401, 409].includes(response.status)
          ? { status: "failed", error: body.error }
          : deliveryFailed;
      if (result === deliveryFailed && response) console.warn("[Quiz Generator] Background callback could not deliver questions", { status: response.status });
    } catch (error) {
      console.warn("[Quiz Generator] Background callback interrupted", { type: error?.name });
      result = deliveryFailed;
    }
    if (result === deliveryFailed) {
      try {
        const execution = await (await quizExecutionObject(this.env, job.id).fetch("https://quiz-job.internal/execution-result")).json();
        if (execution.status === "complete") {
          const { status, body } = execution.result;
          result = status === 200 && Array.isArray(body?.questions) && body.questions.length
            ? { status: "complete", questions: body.questions }
            : { status: "failed", error: typeof body?.error === "string" ? body.error : failed };
        } else if (execution.status === "running" && Date.now() < (job.startedAt || 0) + 120_000) {
          await this.storage.setAlarm(Date.now() + 5000);
          return;
        } else if (execution.status === "none" && !job.recover && !job.retried) {
          await this.storage.transaction(async txn => {
            const current = await txn.get("job");
            if (current?.id !== job.id || current.status !== "running") return;
            await txn.put("job", { ...current, status: "queued", retried: true });
            await txn.setAlarm(Date.now() + 1000);
          });
          return;
        }
      } catch { /* The watchdog alarm retries reading a result without browser activity. */
        if (Date.now() < (job.startedAt || 0) + 120_000) { await this.storage.setAlarm(Date.now() + 5000); return; }
      }
    }
    await this.storage.transaction(async txn => {
      const current = await txn.get("job");
      if (current?.id !== job.id || current.status !== "running") return;
      const { id, details, expiresAt } = current;
      await txn.put("job", { id, details, expiresAt, ...result });
      await txn.setAlarm(expiresAt);
    });
  }
}

export default { fetch: () => new Response(null, { status: 404 }) };
