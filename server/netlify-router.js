import { onRequest as protect } from "../functions/_middleware.js";
import { authApi } from "./web-auth.js";
import { webData } from "./web-data.js";
import { accountAccess } from "./account-access.js";
import { studentQuizzes } from "./student-quizzes.js";
import { quizReview } from "./quiz-review.js";

export async function netlifyRouter({ request, env, store, ip, jobs, waitUntil = () => {} }) {
  // Netlify supplies the client IP through its runtime context. Never trust a
  // visitor's Cloudflare header on the independent host.
  const headers = new Headers(request.headers);
  headers.delete("CF-Connecting-IP");
  if (ip) headers.set("CF-Connecting-IP", ip);
  request = new Request(request, { headers });
  const context = { request, env, waitUntil };
  return protect({ ...context, next: async () => {
    const path = new URL(request.url).pathname;
    if (/^\/api\/web-auth\/[a-z-]+\/?$/.test(path)) return authApi(context);
    if (/^\/api\/web-data(?:\/[a-z-]+)?\/?$/.test(path)) return webData(context);
    if (/^\/api\/account-access\/[a-z-]+\/?$/.test(path)) return accountAccess(context);
    if (/^\/api\/student-quizzes\/[a-z-]+\/?$/.test(path)) return studentQuizzes(context);
    if (/^\/api\/quiz-review\/[a-z-]+\/?$/.test(path)) return quizReview(context);
    if (/^\/api\/quiz-jobs\/(?:start|chunk|run|status)\/?$/.test(path)) return jobs({ ...context, store });
    if (path === "/api/generate-quiz") return Response.json({ error: "Refresh this backup website to use the quiz upload service." }, { status: 409 });
    return Response.json({ error: "Not found." }, { status: 404 });
  } });
}
