import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const script = readFileSync(new URL("../js/navigation-menu.js", import.meta.url), "utf8");
const style = readFileSync(new URL("../css/portal-design.css", import.meta.url), "utf8");
const prefix = "/assets/site-01234567890123456789/";
function setup(connection) {
  const events = new Map(), windowEvents = new Map(), links = [], timers = new Map(); let timer = 0;
  const context = { URL, Set, Array, JSON, navigator: { connection },
    window: { location: { href: "https://imars.test/", origin: "https://imars.test" }, addEventListener: (name, callback) => windowEvents.set(name, callback) },
    document: { getElementById: () => null, readyState: "loading", querySelectorAll: () => [{ href: "https://imars.test" + prefix + "style-shared.css" }],
      addEventListener: (name, callback) => events.set(name, callback), createElement: () => ({ setAttribute() {} }), head: { append: link => links.push(link) } },
    setTimeout: callback => { timers.set(++timer, callback); return timer; }, clearTimeout: id => timers.delete(id) };
  vm.runInNewContext(script, context);
  const link = assets => ({ dataset: { navAssets: JSON.stringify(assets) }, contains: () => false });
  const event = target => ({ target: { closest: () => target }, relatedTarget: null });
  const flush = () => { for (const callback of timers.values()) callback(); timers.clear(); };
  return { context, events, windowEvents, links, link, event, flush };
}

test("hover warms only versioned public assets, does not execute scripts and deduplicates shared designs", () => {
  const f = setup();
  const target = f.link([{ href: prefix + "app-records.js", as: "script" }, { href: prefix + "style-shared.css", as: "style" },
    { href: "/api/web-data", as: "script" }, { href: "/student-records", as: "script" }, { href: "https://other.test" + prefix + "app-other.js", as: "script" }]);
  f.events.get("pointerover")(f.event(target)); assert.equal(f.links.length, 0); f.flush();
  assert.equal(f.links.length, 1); assert.equal(f.links[0].rel, "prefetch"); assert.equal(f.links[0].as, "script");
  assert.equal(f.links[0].href, "https://imars.test" + prefix + "app-records.js");
  f.events.get("focusin")(f.event(target)); assert.equal(f.links.length, 1);
});

test("quick pointer movement, page exit, data saver and slow connections do not trigger warming", () => {
  const assets = [{ href: prefix + "app-records.js", as: "script" }];
  const f = setup(), target = f.link(assets);
  f.events.get("pointerover")(f.event(target)); f.events.get("pointerout")(f.event(target)); f.flush(); assert.equal(f.links.length, 0);
  f.events.get("pointerover")(f.event(target)); f.windowEvents.get("pagehide")(); f.flush(); assert.equal(f.links.length, 0);
  for (const connection of [{ saveData: true }, { effectiveType: "2g" }, { effectiveType: "slow-2g" }]) {
    const slow = setup(connection); slow.events.get("focusin")(slow.event(slow.link(assets))); assert.equal(slow.links.length, 0);
  }
});

test("the public-only cache is registered after page load without blocking the page", () => {
  const f = setup(), registrations = [];
  f.context.navigator.serviceWorker = { register: (url, options) => { registrations.push([url, options.updateViaCache]); return Promise.resolve(); } };
  vm.runInNewContext(script, { ...f.context });
  assert.equal(registrations.length, 0); f.windowEvents.get("load")();
  assert.deepEqual(registrations, [["/sw.js", "none"]]);
});

test("transitions capture public navigation only and respect reduced motion; login never opts in", () => {
  assert.match(style, /prefers-reduced-motion:no-preference/);
  assert.match(style, /:root\s*\{\s*view-transition-name:none/);
  assert.match(style, /#drawer \.side-nav\s*\{\s*view-transition-name:portal-navigation/);
  assert.doesNotMatch(style, /(?:main|\.side-user|\.drawer-panel)\s*\{\s*view-transition-name:/);
  for (const file of ["login.html", "admin-login.html"]) {
    const html = readFileSync(new URL("../" + file, import.meta.url), "utf8");
    assert.ok(!/<link\b[^>]*rel="stylesheet"[^>]*href="css\/portal-design.css"/.test(html));
  }
});
