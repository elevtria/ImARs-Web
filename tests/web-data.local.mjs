// Local browser fixture only. No credentials, production records or AI calls.
import http from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fixture } from "./fixtures/web-data.js";
import { authApi } from "../server/web-auth.js";
import { webData } from "../server/web-data.js";
import { onRequest } from "../functions/_middleware.js";

const app = fixture();
for (const [name, row] of app.data) if (name.startsWith("users/")) {
  row.fullName ||= row.displayName || (row.role === "admin" ? "Preview Administrator" : row.role === "teacher" ? "Preview Teacher" : "Preview Student");
  row.displayName ||= row.fullName;
}
for (const term of ["term_01", "term_02", "term_03"]) {
  app.data.set("terms/" + term, { title: term.replace("term_0", "Term ") });
  for (let number = 1; number <= 4; number++) app.data.set(`terms/${term}/lessons/lesson_0${number}`, { lessonName: "Preview lesson " + number, isLocked: false, scheduledDate: "" });
}
const root = path.resolve("dist");
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, "http://127.0.0.1:8848");
    const buffers = []; for await (const chunk of req) buffers.push(chunk);
    const request = new Request(url, { method: req.method, headers: req.headers,
      ...(["GET", "HEAD"].includes(req.method) ? {} : { body: Buffer.concat(buffers) }) });
    const next = async () => {
      if (url.pathname.startsWith("/api/web-auth/")) return authApi({ request, env: app.env }, Date.now(), { store: app.store });
      if (url.pathname.startsWith("/api/web-data")) return webData({ request, env: app.env }, { store: app.store });
      let relative = decodeURIComponent(url.pathname).replace(/^\//, "") || "index";
      if (/^[\w-]+$/.test(relative)) relative += ".html";
      const file = path.resolve(root, relative);
      if (!file.startsWith(root + path.sep)) return new Response("Not found", { status: 404 });
      const content = await readFile(file).catch(() => null);
      if (!content) return new Response("Not found", { status: 404 });
      const type = relative.endsWith(".js") ? "text/javascript" : relative.endsWith(".css") ? "text/css" : relative.endsWith(".png") ? "image/png" : "text/html; charset=utf-8";
      return new Response(content, { headers: { "Content-Type": type } });
    };
    const response = await onRequest({ request, env: app.env, next });
    res.writeHead(response.status, Object.fromEntries(response.headers)); res.end(Buffer.from(await response.arrayBuffer()));
  } catch (error) { console.error(error.message); res.writeHead(500); res.end("Local preview failed"); }
});
server.listen(8848, "127.0.0.1", () => console.log("Synthetic gateway preview: http://127.0.0.1:8848/login — TEACH1000 / ADMIN1000, password: correct"));
