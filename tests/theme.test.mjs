import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const source = readFileSync(new URL("../js/theme.js", import.meta.url), "utf8");
function page({ saved = null, dark = false, blocked = false, toolbar = true } = {}) {
  const events = {}, systemEvents = {}, attrs = {}, writes = [];
  const root = { dataset: {} };
  let button, mounted;
  const system = { matches: dark, addEventListener: (name, fn) => { systemEvents[name] = fn; } };
  const context = {
    window: { matchMedia: () => system, addEventListener: (name, fn) => { events[name] = fn; } },
    localStorage: {
      getItem() { if (blocked) throw Error("Storage disabled"); return saved; },
      setItem(key, value) { if (blocked) throw Error("Storage disabled"); writes.push([key, value]); }
    },
    document: {
      documentElement: root,
      addEventListener: (name, fn) => { events[name] = fn; },
      querySelector: () => toolbar ? { prepend: el => { mounted = el; } } : null,
      body: { append: el => { mounted = el; } },
      createElement: () => (button = {
        classList: { add() {} }, setAttribute: (key, value) => { attrs[key] = value; },
        getAttribute: key => attrs[key], addEventListener: (name, fn) => { events[name] = fn; }
      })
    }
  };
  vm.runInNewContext(source, context);
  return { root, attrs, writes, events, system, systemEvents,
    mount() { events.DOMContentLoaded(); assert.equal(mounted, button); } };
}

test("applies saved preference before mounting the toggle, ahead of the system setting", () => {
  const app = page({ saved: "light", dark: true });
  assert.equal(app.root.dataset.theme, "light");
  app.mount();
  assert.equal(app.attrs["aria-pressed"], "false");
});
test("uses device preference and follows changes until the user chooses", () => {
  const app = page({ dark: true });
  assert.equal(app.root.dataset.theme, "dark");
  app.mount();
  app.system.matches = false;
  app.systemEvents.change();
  assert.equal(app.root.dataset.theme, "light");
  app.events.click();
  assert.deepEqual(app.writes, [["imars-theme", "dark"]]);
  assert.equal(app.attrs["aria-label"], "Switch to light mode");
  app.systemEvents.change();
  assert.equal(app.root.dataset.theme, "dark");
  app.events.click();
  assert.equal(app.attrs["aria-pressed"], "false");
});
test("toggle works when browser storage is blocked and without a toolbar", () => {
  const app = page({ blocked: true, toolbar: false });
  app.mount();
  app.events.click();
  assert.equal(app.root.dataset.theme, "dark");
});
test("syncs other tabs and restores system preference when storage is cleared", () => {
  const app = page();
  app.mount();
  app.events.storage({ key: "unrelated", newValue: "dark" });
  assert.equal(app.root.dataset.theme, "light");
  app.events.storage({ key: "imars-theme", newValue: "dark" });
  assert.equal(app.attrs["aria-pressed"], "true");
  app.events.storage({ key: null, newValue: null });
  assert.equal(app.root.dataset.theme, "light");
});
test("ignores invalid saved themes", () => {
  assert.equal(page({ saved: "invalid", dark: true }).root.dataset.theme, "dark");
});
test("every page loads the shared theme early and styles after page styles", () => {
  const root = new URL("../", import.meta.url);
  for (const name of readdirSync(root).filter(name => name.endsWith(".html"))) {
    const html = readFileSync(new URL(name, root), "utf8");
    assert.ok(html.indexOf('src="js/theme.js"') < html.indexOf('rel="stylesheet"'), name);
    assert.equal((html.match(/src="js\/theme.js"/g) || []).length, 1, name);
    assert.ok(html.lastIndexOf('rel="stylesheet"') < html.indexOf('href="css/theme.css"'), name);
  }
});
