import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const source = readFileSync(new URL("../js/theme.js", import.meta.url), "utf8");
function page({ saved = null, dark = false, blocked = false, toolbar = true, animated = false, reducedMotion = false, failedTransition = false } = {}) {
  const events = {}, systemEvents = {}, attrs = {}, writes = [];
  const animations = [], transitions = [];
  const rootClasses = new Set();
  const root = { dataset: {}, classList: {
    contains: name => rootClasses.has(name),
    add: name => rootClasses.add(name),
    remove: name => rootClasses.delete(name)
  } };
  if (animated) root.animate = (frames, options) => { animations.push({ frames, options }); };
  let button, mounted;
  const system = { matches: dark, addEventListener: (name, fn) => { systemEvents[name] = fn; } };
  const context = {
    setTimeout: callback => { events.finishSwitch = callback; return 1; },
    clearTimeout() {},
    window: { innerWidth: 1000, innerHeight: 700,
      matchMedia: query => query.includes("reduced-motion") ? { matches: reducedMotion } : system,
      addEventListener: (name, fn) => { events[name] = fn; } },
    localStorage: {
      getItem() { if (blocked) throw Error("Storage disabled"); return saved; },
      setItem(key, value) { if (blocked) throw Error("Storage disabled"); writes.push([key, value]); }
    },
    document: {
      documentElement: root,
      ...(animated ? { startViewTransition: apply => {
        if (failedTransition) throw Error("Transition unavailable");
        let ready, finish;
        const transition = {
          ready: new Promise(resolve => { ready = resolve; }),
          finished: new Promise(resolve => { finish = resolve; })
        };
        transitions.push({ ready, finish });
        apply();
        return transition;
      } } : {}),
      addEventListener: (name, fn) => { events[name] = fn; },
      querySelector: () => toolbar ? { prepend: el => { mounted = el; } } : null,
      body: { append: el => { mounted = el; } },
      createElement: () => (button = {
        getBoundingClientRect: () => ({ left: 910, top: 16, width: 40, height: 40 }),
        classList: { add() {} }, setAttribute: (key, value) => { attrs[key] = value; },
        getAttribute: key => attrs[key], addEventListener: (name, fn) => { events[name] = fn; }
      })
    }
  };
  vm.runInNewContext(source, context);
  return { root, attrs, writes, events, system, systemEvents, animations, transitions,
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

test("theme colors change on the visible page without a full-page snapshot, even during rapid clicks", () => {
  const app = page({ animated: true });
  app.mount();
  app.events.click();
  assert.equal(app.root.dataset.theme, "dark");
  assert.equal(app.root.classList.contains("theme-switching"), true);
  app.events.click();
  assert.equal(app.transitions.length, 0);
  assert.equal(app.animations.length, 0);
  assert.equal(app.writes.length, 2);
  assert.equal(app.root.dataset.theme, "light");
  assert.equal(app.root.dataset.themeReveal, undefined);
  app.events.finishSwitch();
  assert.equal(app.root.classList.contains("theme-switching"), false);
  app.events.click();
  assert.equal(app.root.dataset.theme, "dark");
  app.events.pagehide();
  assert.equal(app.root.classList.contains("theme-switching"), false);
});

test("reduced motion changes the palette immediately without a page transition", () => {
  const app = page({ animated: true, reducedMotion: true });
  app.mount();
  app.events.click();
  assert.equal(app.root.dataset.theme, "dark");
  assert.equal(app.transitions.length, 0);
  assert.equal(app.animations.length, 0);
});

test("a browser with broken snapshot transitions still switches both palettes", () => {
  const app = page({ animated: true, failedTransition: true });
  app.mount();
  app.events.click();
  assert.equal(app.root.dataset.theme, "dark");
  assert.equal(app.transitions.length, 0);
  assert.equal(app.root.dataset.themeReveal, undefined);
  app.events.click();
  assert.equal(app.root.dataset.theme, "light");
});
test("every page loads the shared theme early and styles after page styles", () => {
  const root = new URL("../", import.meta.url);
  for (const name of readdirSync(root).filter(name => name.endsWith(".html") && !name.startsWith("_"))) {
    const html = readFileSync(new URL(name, root), "utf8");
    assert.ok(html.indexOf('src="js/theme.js"') < html.indexOf('rel="stylesheet"'), name);
    assert.equal((html.match(/src="js\/theme.js"/g) || []).length, 1, name);
    assert.ok(html.lastIndexOf('rel="stylesheet"') < html.indexOf('href="css/theme.css"'), name);
  }
});
