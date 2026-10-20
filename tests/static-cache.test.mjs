import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import test from "node:test";
import { cacheStaticAssets, staticAssetPlan, versionHtmlAssets } from "../scripts/cache-static-assets.mjs";

test("identical assets keep their cache URLs; changing bytes, adding files, or renaming a file changes the version", () => {
  const files = new Map([["js/main.js", Buffer.from('import "./data.js";')], ["js/data.js", Buffer.from("export const value = 1;")]]);
  const first = staticAssetPlan(files);
  assert.equal(staticAssetPlan(new Map([...files].reverse())).prefix, first.prefix);
  assert.notEqual(staticAssetPlan(new Map([...files, ["js/data.js", Buffer.from("export const value = 2;")]])).prefix, first.prefix);
  assert.notEqual(staticAssetPlan(new Map([...files, ["js/extra.js", Buffer.from("")]])).prefix, first.prefix);
  assert.notEqual(staticAssetPlan(new Map([["js/renamed.js", files.get("js/main.js")], ["js/data.js", files.get("js/data.js")]])).prefix, first.prefix);
  assert.equal(new URL("./data.js", "https://example.test" + first.urls.get("/js/main.js")).pathname, first.urls.get("/js/data.js"));
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

test("build output has versioned import dependencies, working loader URLs, and exact immutable rules without modifying source assets", async t => {
  const base = resolve(tmpdir());
  const output = await mkdtemp(join(base, "imars-cache-test-"));
  t.after(async () => {
    // The only recursively removed path is this test's own generated temp folder.
    assert.ok(resolve(output).startsWith(base + sep + "imars-cache-test-"));
    await rm(output, { recursive: true, force: true });
  });
  const fixtures = new Map([
    ["js/loading.js", 'import "./data.js";\nconst logo = new URL("../assets/imars-loader-transparent.png", import.meta.url);'],
    ["js/data.js", 'export const value = 1;'], ["css/app.css", "body { color: black; }"],
    ["assets/imars-logo.png", "logo bytes"], ["assets/imars-loader-transparent.png", "loader bytes"],
    ["assets/markers/topic.zip", "ZIP bytes"],
    ["index.html", '<script src="js/loading.js" type="module"></script><link href="css/app.css"><img src="assets/imars-logo.png"><a href="login.html">Login</a>']
  ]);
  for (const [name, content] of fixtures) { await mkdir(dirname(join(output, name)), { recursive: true }); await writeFile(join(output, name), content); }
  const { prefix, count } = await cacheStaticAssets(output, ["index.html"]);
  assert.equal(count, 5);
  const script = await readFile(join(output, prefix.slice(1), "js/loading.js"), "utf8");
  assert.equal(script, fixtures.get("js/loading.js"));
  const loaderUrl = new URL("../assets/imars-loader-transparent.png", "https://example.test" + prefix + "/js/loading.js");
  assert.equal(await readFile(join(output, loaderUrl.pathname.slice(1)), "utf8"), "loader bytes");
  assert.equal(await readFile(join(output, "js/data.js"), "utf8"), 'export const value = 1;');
  assert.equal(await readFile(join(output, "assets/markers/topic.zip"), "utf8"), "ZIP bytes");
  assert.deepEqual((await readdir(join(output, prefix.slice(1), "assets"))).sort(), ["imars-loader-transparent.png", "imars-logo.png"]);
  const headers = await readFile(join(output, "_headers"), "utf8");
  assert.equal(headers.split("Cache-Control:").length - 1, count);
  assert.ok(headers.includes("Cache-Control: public, max-age=31536000, immutable"));
  assert.ok((await readFile(join(output, "index.html"), "utf8")).includes(`src="${prefix}/js/loading.js"`));
});
