import { quizJobIdPattern, quizJobLifetime, quizJobResponse as json } from "../server/quiz-background.js";

const failed = "Quiz generation could not finish. Please try again.";
const active = job => ["queued", "running"].includes(job?.status);

export class QuizGenerationJob {
  constructor(state, env) {
    this.storage = state.storage;
    this.callback = new URL("/api/run-quiz-job", env.QUIZ_JOB_CALLBACK_ORIGIN).href;
  }

  async fetch(request) {
    const now = Date.now();
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
      const { id, status, details, questions, error } = job;
      return json({ id, status, details, questions, error });
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
      if (!current) return null;
      if (current.expiresAt <= now) {
        await txn.delete("job");
        return null;
      }
      if (current.status === "running") {
        const { callback, ...record } = current;
        await txn.put("job", { ...record, status: "failed", error: failed });
        await txn.setAlarm(current.expiresAt);
        return null;
      }
      if (current.status !== "queued") {
        await txn.setAlarm(current.expiresAt);
        return null;
      }
      await txn.put("job", { ...current, status: "running" });
      await txn.setAlarm(now + 120_000);
      return current;
    });
    if (!job) return;
    let result;
    try {
      const response = await fetch(this.callback, {
        method: "POST", redirect: "error", signal: AbortSignal.timeout(95_000),
        headers: { "Content-Type": "application/json", "X-Imars-Quiz-Signature": job.callback.signature },
        body: job.callback.body
      });
      const body = await response.json();
      result = response.ok && Array.isArray(body.questions) && body.questions.length
        ? { status: "complete", questions: body.questions }
        : { status: "failed", error: typeof body.error === "string" ? body.error : failed };
    } catch { result = { status: "failed", error: failed }; }
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
