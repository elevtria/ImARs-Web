import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import vm from "node:vm";
import test from "node:test";
import { assertPublicClientContent, cacheStaticAssets, minifyPublicAssets, staticAssetPlan, versionHtmlAssets } from "../scripts/cache-static-assets.mjs";

test("offline service worker caches public assets while leaving portal HTML and API data on the network", async () => {
  const handlers = new Map(), deleted = [];
  const context = {
    URL, self: { location: { origin: "https://example.test" }, clients: { claim: async () => {} }, addEventListener: (type, callback) => handlers.set(type, callback) },
    caches: { keys: async () => ["imars-teacher-v1", "unrelated"], delete: async name => deleted.push(name), open: async () => ({ match: async () => new Response("cached script") }) },
    fetch: async () => { throw new Error("Offline"); }
  };
  vm.runInNewContext(await readFile(new URL("../js/sw.js", import.meta.url), "utf8"), context);
  let activated;
  handlers.get("activate")({ waitUntil: promise => { activated = promise; } });
  await activated; assert.deepEqual(deleted, ["imars-teacher-v1"]);
  for (const [path, destination] of [["/admin-dashboard", "document"], ["/api/web-data", ""], ["/assets/site-123/record.json", ""]]) {
    handlers.get("fetch")({ request: { method: "GET", url: "https://example.test" + path, destination }, respondWith: () => assert.fail("Private responses must not use offline cache") });
  }
  let saved;
  handlers.get("fetch")({ request: { method: "GET", url: "https://example.test/assets/site-123/js/app.js", destination: "script" }, respondWith: promise => { saved = promise; } });
  assert.equal(await (await saved).text(), "cached script");
});

test("identical assets keep their cache URLs; changing bytes, adding files, or renaming a file changes the version", () => {
  const files = new Map([["js/main.js", Buffer.from('import "./data.js";')], ["js/data.js", Buffer.from("export const value = 1;")]]);
  const first = staticAssetPlan(files);
  assert.equal(staticAssetPlan(new Map([...files].reverse())).prefix, first.prefix);
  assert.notEqual(staticAssetPlan(new Map([...files, ["js/data.js", Buffer.from("export const value = 2;")]])).prefix, first.prefix);
  assert.notEqual(staticAssetPlan(new Map([...files, ["js/extra.js", Buffer.from("")]])).prefix, first.prefix);
  assert.notEqual(staticAssetPlan(new Map([["js/renamed.js", files.get("js/main.js")], ["js/data.js", files.get("js/data.js")]])).prefix, first.prefix);
  assert.equal(new URL("./data.js", "https://example.test" + first.urls.get("/js/main.js")).pathname, first.urls.get("/js/data.js"));
});

test("production minification preserves module exports, classic-script globals, URLs, styles and visible text", async t => {
  const base = resolve(tmpdir()), output = await mkdtemp(join(base, "imars-minify-test-"));
  t.after(async () => {
    assert.ok(resolve(output).startsWith(base + sep + "imars-minify-test-"));
    await rm(output, { recursive: true, force: true });
  });
  const fixtures = new Map([
    ["package.json", '{"type":"module"}'],
    ["js/main.js", 'import { points } from "./scores.js";\n// Editable source comment.\nexport const label = "Loading your data…";\nexport function total(count) { return points * count; }\nexport const logo = new URL("../assets/imars-logo.png", import.meta.url);'],
    ["js/scores.js", 'export const points = 5;'],
    ["js/ui.js", 'function openMenu() { return "Menu ready"; }\nwindow.openMenu = openMenu;'],
    ["css/app.css", '/* Theme */\n:root { --gold: #feb705; }\nbody[data-auth-pending] { visibility: hidden; }\n.login-submit[aria-busy="true"] { color: var(--gold); }'],
    ["index.html", '<!doctype html>\n<html><head><title>Teacher portal</title></head><body data-auth-pending>\n<!-- Source note -->\n<p><span>Sign in</span> <strong>to continue</strong></p><pre>keep  two\nlines</pre><script src="js/ui.js"></script><script type="module" src="js/main.js"></script><link rel="stylesheet" href="css/app.css"></body></html>'],
    ["assets/imars-logo.png", "logo bytes"], ["assets/imars-loader-transparent.png", "loader bytes"]
  ]);
  for (const [name, content] of fixtures) { await mkdir(dirname(join(output, name)), { recursive: true }); await writeFile(join(output, name), content); }
  const compact = await minifyPublicAssets(output, ["index.html"]);
  assert.equal(compact.count, 5); assert.ok(compact.after < compact.before);
  const rawModule = await readFile(join(output, "js/main.js"), "utf8");
  assert.ok(!rawModule.includes("Editable source comment")); assert.ok(!rawModule.includes("sourceMappingURL"));
  const { urls } = await cacheStaticAssets(output, ["index.html"]);
  const module = await import(pathToFileURL(join(output, urls.get("/js/main.js").slice(1))));
  assert.equal(module.total(3), 15); assert.equal(module.label, "Loading your data…");
  assert.equal(await readFile(module.logo, "utf8"), "logo bytes");
  const browser = { window: {} };
  vm.runInNewContext(await readFile(join(output, urls.get("/js/ui.js").slice(1)), "utf8"), browser);
  assert.equal(browser.window.openMenu(), "Menu ready");
  const html = await readFile(join(output, "index.html"), "utf8");
  assert.ok(!html.includes("Source note")); assert.match(html, /<\/span> <strong>/);
  assert.ok(html.includes('<pre>keep  two\nlines</pre>'));
  assert.ok(html.includes('data-auth-pending')); assert.ok(html.includes(`src="${urls.get("/js/main.js")}"`));
  const css = await readFile(join(output, "css/app.css"), "utf8");
  assert.ok(css.includes("body[data-auth-pending]")); assert.ok(css.includes("--gold:")); assert.ok(css.includes("aria-busy=true"));
});

test("public-artifact checks reject private credentials and direct browser Firebase configuration", () => {
  for (const content of [
    'const key = "-----BEGIN PRIVATE KEY-----";',
    '{"type":"service_account","project_id":"example"}',
    'const GEMINI_API_KEY = "synthetic-private-value";',
    'const config = { WEB_SESSION_SECRET: "synthetic-private-value" };'
  ]) assert.throws(() => assertPublicClientContent(content, "js/client.js"), /Private server credentials/);
  assert.throws(() => assertPublicClientContent('const firebaseConfig = { apiKey: "public-browser-config", projectId: "example" };', "js/login.js"), /authenticated website API/);
});

test("HTML versioning changes only known local public files and preserves routes, downloads, remote scripts, and URL suffixes", () => {
  const plan = staticAssetPlan(new Map([["css/app.css", Buffer.from("")], ["js/main.js", Buffer.from("")], ["assets/logo.png", Buffer.from("")]]));
  const html = `<link href="css/app.css?v=old#theme"><script src='./js/main.js'></script><img src="/assets/logo.png"><a href="admin-profile.html">Profile</a><a href="assets/markers/topic.zip?v=123" download>ZIP</a><script src="https://cdn.example/js/main.js"></script><a href="/api/report">API</a>`;
  const updated = versionHtmlAssets(html, plan.urls);
  assert.ok(updated.includes(`href="${plan.prefix}/css/app.css?v=old#theme"`));
  assert.ok(updated.includes(`src='${plan.prefix}/js/main.js'`));
  assert.ok(updated.includes(`src="${plan.prefix}/assets/logo.png"`));
  for (const original of ['href="admin-profile.html"', 'href="assets/markers/topic.zip?v=123"', 'src="https://cdn.example/js/main.js"', 'href="/api/report"']) assert.ok(updated.includes(original));
  assert.equal(plan.headers.includes("/api/"), false);
  assert.equal(plan.headers.includes("/*"), false);
  assert.equal(plan.headers.includes(".html"), false);
});

test("bundled output preserves loader URLs, downloads and immutable caching without modifying source assets", async t => {
  const base = resolve(tmpdir());
  const output = await mkdtemp(join(base, "imars-cache-test-"));
  t.after(async () => {
    // The only recursively removed path is this test's own generated temp folder.
    assert.ok(resolve(output).startsWith(base + sep + "imars-cache-test-"));
    await rm(output, { recursive: true, force: true });
  });
  const fixtures = new Map([
    ["package.json", '{"type":"module"}'],
    ["js/loading.js", 'import { value } from "./data.js"; export { value }; export const logo = new URL("../assets/imars-loader-transparent.png", import.meta.url);'],
    ["js/data.js", 'export const value = 1;'], ["css/app.css", "body { color: black; }"],
    ["assets/imars-logo.png", "logo bytes"], ["assets/imars-loader-transparent.png", "loader bytes"],
    ["assets/markers/topic.zip", "ZIP bytes"],
    ["index.html", '<script src="js/loading.js" type="module"></script><link href="css/app.css"><img src="assets/imars-logo.png"><a href="login.html">Login</a>']
  ]);
  for (const [name, content] of fixtures) { await mkdir(dirname(join(output, name)), { recursive: true }); await writeFile(join(output, name), content); }
  const { prefix, count, urls } = await cacheStaticAssets(output, ["index.html"]);
  const module = await import(pathToFileURL(join(output, urls.get("/js/loading.js").slice(1))));
  assert.equal(module.value, 1);
  assert.equal(await readFile(module.logo, "utf8"), "loader bytes");
  assert.equal(await readFile(join(output, "js/data.js"), "utf8"), 'export const value = 1;');
  assert.equal(await readFile(join(output, "assets/markers/topic.zip"), "utf8"), "ZIP bytes");
  const published = await readdir(join(output, prefix.slice(1)));
  assert.ok(published.every(name => /^(?:app|chunk|style|asset)-[\w-]+\.(?:js|css|png)$/.test(name)));
  assert.ok(!published.some(name => /loading|data|imars/.test(name)));
  const headers = await readFile(join(output, "_headers"), "utf8");
  assert.equal(headers.split("Cache-Control:").length - 1, count);
  assert.ok(headers.includes("Cache-Control: public, max-age=31536000, immutable"));
  assert.ok((await readFile(join(output, "index.html"), "utf8")).includes(`src="${urls.get("/js/loading.js")}"`));
});

test("separate page entries and lazy imports share one session object and retain runtime styles and classic globals", async t => {
  const base = resolve(tmpdir()), output = await mkdtemp(join(base, "imars-bundle-test-"));
  t.after(async () => {
    assert.ok(resolve(output).startsWith(base + sep + "imars-bundle-test-"));
    await rm(output, { recursive: true, force: true });
  });
  const fixtures = new Map([
    ["package.json", '{"type":"module"}'],
    ["js/session.js", 'export const session = { visits: 0 }; export const style = new URL("../css/session.css", import.meta.url);'],
    ["js/first.js", 'import { session, style } from "./session.js"; session.visits++; export { session, style }; export const later = () => import("./session.js");'],
    ["js/second.js", 'import { session } from "./session.js"; session.visits++; export { session };'],
    ["js/scanner.js", 'var Scanner = { ready: true }; function openScanner() { return Scanner.ready; }'],
    ["css/session.css", '.notice { color: red; }'],
    ["assets/imars-logo.png", "logo bytes"], ["assets/imars-loader-transparent.png", "loader bytes"],
    ["index.html", '<script src="https://cdn.example/library.js"></script><script src="js/scanner.js"></script><script type="module" src="js/first.js"></script><script type="module" src="js/second.js"></script>']
  ]);
  for (const [name, content] of fixtures) { await mkdir(dirname(join(output, name)), { recursive: true }); await writeFile(join(output, name), content); }
  await minifyPublicAssets(output, ["index.html"]);
  const { prefix, urls } = await cacheStaticAssets(output, ["index.html"]);
  const first = await import(pathToFileURL(join(output, urls.get("/js/first.js").slice(1))));
  const second = await import(pathToFileURL(join(output, urls.get("/js/second.js").slice(1))));
  assert.equal(first.session, second.session);
  assert.equal(first.session.visits, 2);
  assert.equal((await first.later()).session, first.session);
  assert.match(await readFile(first.style, "utf8"), /color:red/);
  const browser = {};
  vm.runInNewContext(await readFile(join(output, urls.get("/js/scanner.js").slice(1)), "utf8"), browser);
  assert.equal(browser.openScanner(), true);
  assert.equal(browser.Scanner.ready, true);
  const html = await readFile(join(output, "index.html"), "utf8");
  assert.ok(html.indexOf("https://cdn.example/library.js") < html.indexOf(urls.get("/js/scanner.js")));
  assert.ok(html.indexOf(urls.get("/js/scanner.js")) < html.indexOf(urls.get("/js/first.js")));
  for (const name of await readdir(join(output, prefix.slice(1)))) {
    assert.ok(!name.endsWith(".map"));
    if (name.endsWith(".js")) assert.ok(!(await readFile(join(output, prefix.slice(1), name), "utf8")).includes("sourceMappingURL"));
  }
});
