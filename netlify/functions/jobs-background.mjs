import { netlifyEnvironment, verifyJob } from "../../server/netlify-runtime.js";
import { runNetlifyQuiz } from "../../server/netlify-quiz-jobs.js";

export default async request => {
  let job, runtime;
  try {
    job = await verifyJob(request, process.env.NETLIFY_BACKGROUND_SECRET);
    runtime = netlifyEnvironment(key => process.env[key]);
  } catch { return new Response(null, { status: 403 }); }
  const { env, store } = runtime;
  if (job.kind === "quiz") { await runNetlifyQuiz(job.id, env, store); return new Response(null, { status: 200 }); }
  const key = "dashboard-runner/" + job.name, previous = await store.getWithMetadata(key, { type: "json", consistency: "strong" });
  if (previous?.data.until > Date.now()) return new Response(null, { status: 200 });
  const owner = crypto.randomUUID();
  let lease = await store.setJSON(key, { owner, until: Date.now() + 90_000 }, previous ? { onlyIfMatch: previous.etag } : { onlyIfNew: true });
  if (!lease.modified) return new Response(null, { status: 200 });
  const started = Date.now();
  try {
    // Each step retains the same 25-profile/100-document read bounds used by
    // Cloudflare. The job can outlive a browser navigation or closed tab.
    for (let batch = 0; batch < 200 && Date.now() - started < 600_000; batch++) {
      await new Promise(resolve => setTimeout(resolve, 1100));
      if (!await env.WEB_LOGIN_STATE.step(job.name)) break;
      lease = await store.setJSON(key, { owner, until: Date.now() + 90_000 }, { onlyIfMatch: lease.etag });
      if (!lease.modified) return new Response(null, { status: 200 });
    }
  } finally {
    if (lease.modified) await store.setJSON(key, { owner, until: 0 }, { onlyIfMatch: lease.etag });
  }
  return new Response(null, { status: 200 });
};
