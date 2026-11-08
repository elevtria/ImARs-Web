import { netlifyEnvironment } from "../../server/netlify-runtime.js";
import { netlifyRouter } from "../../server/netlify-router.js";
import { netlifyQuizJobs } from "../../server/netlify-quiz-jobs.js";

export default async (request, context) => {
  const started = Date.now();
  try {
    const { env, store } = netlifyEnvironment(key => process.env[key]);
    const pending = [];
    const response = await netlifyRouter({ request, env, store, ip: context.ip, jobs: netlifyQuizJobs, waitUntil: task => pending.push(task) });
    await Promise.allSettled(pending);
    console.info(JSON.stringify({ event: "backup-api", path: new URL(request.url).pathname, status: response.status,
      durationMs: Date.now() - started, serverTiming: response.headers.get("Server-Timing") }));
    return response;
  } catch { return Response.json({ error: "The backup service setup is incomplete or temporarily unavailable." }, { status: 503, headers: { "Cache-Control": "no-store" } }); }
};
export const config = { path: "/api/*", preferStatic: false };
