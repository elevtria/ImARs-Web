import { netlifyEnvironment, dispatchJob } from "../../server/netlify-runtime.js";

export default async () => {
  const { env, store } = netlifyEnvironment(key => process.env[key]);
  const deadline = Date.now() + 20_000;
  // Scheduled functions are not exposed as public callable endpoints.
  // Retry unfinished dashboard jobs and clear expired private quiz uploads.
  for await (const page of store.list({ prefix: "dashboards/", paginate: true })) {
    for (const blob of page.blobs) {
      if (Date.now() >= deadline) return;
      const record = await store.get(blob.key, { type: "json", consistency: "strong" });
      if (!/^dashboard:[A-Za-z0-9_-]{1,128}$/.test(record?.name)) continue;
      const projection = await store.get(blob.key.replace("dashboards/", "dashboard-view/"), { type: "json", consistency: "strong" });
      if (projection?.pending && (!projection.nextStepAt || projection.nextStepAt <= Date.now())) await dispatchJob(env, { kind: "dashboard", name: record.name });
    }
  }
  let checked = 0;
  for await (const page of store.list({ prefix: "quiz-jobs/", paginate: true })) {
    for (const blob of page.blobs) {
      if (++checked > 100) return;
      if (Date.now() >= deadline) return;
      const job = await store.get(blob.key, { type: "json", consistency: "strong" });
      if (!job || job.expiresAt > Date.now()) continue;
      for (let index = 0; index < job.chunks; index++) await store.delete(`quiz-chunks/${job.id}/${String(index).padStart(2, "0")}`);
      await store.delete(blob.key);
    }
  }
};
export const config = { schedule: "*/5 * * * *" };
