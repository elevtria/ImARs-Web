import { netlifyEnvironment } from "../../server/netlify-runtime.js";
import { onRequest } from "../../functions/_middleware.js";

export default async (request, context) => {
  try {
    const path = new URL(request.url).pathname;
    const publicPage = path === "/" || /^\/(?:welcome|(?:admin-)?login)(?:\.html)?\/?$/.test(path);
    const env = publicPage ? { WEB_LOGIN_ENABLED: "true", WEB_DATA_ENABLED: "true" } : netlifyEnvironment(key => Netlify.env.get(key)).env;
    return await onRequest({ request, env, next: () => context.next(), waitUntil: task => context.waitUntil(task) });
  } catch { return new Response("The backup website is temporarily unavailable.", { status: 503, headers: { "Cache-Control": "no-store", "Content-Type": "text/plain" } }); }
};
