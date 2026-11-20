import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

function guide(reduced = false) {
  const nodes = new Map(), events = {};
  class Element {
    events = {}; hidden = false; open = false; src = "";
    addEventListener(name, callback) { this.events[name] = callback; }
    emit(name, event = {}) { this.events[name]?.(event); }
    removeAttribute(name) { if (name === "src") this.src = ""; }
    showModal() { this.open = true; }
    close() { this.open = false; this.emit("close"); }
  }
  const element = id => { if (!nodes.has(id)) nodes.set(id, new Element()); return nodes.get(id); };
  const media = { matches: reduced, addEventListener(name, callback) { this[name] = callback; } };
  vm.runInNewContext(readFileSync(new URL("../js/scan-guide.js", import.meta.url), "utf8"), {
    document: { getElementById: element },
    window: { matchMedia: () => media, addEventListener(name, callback) { events[name] = callback; } },
    navigator: { mediaDevices: { getUserMedia() { throw Error("Help must never activate the camera"); } } }
  });
  return { element, media, events };
}

test("opening the AR tab does not open help or load its animation; the help button opens it on demand", () => {
  const app = guide(), dialog = app.element("arScanGuide"), image = app.element("arScanGuideImage");
  assert.equal(dialog.open, false);
  assert.equal(image.src, "");
  app.element("openARScanGuide").emit("click");
  assert.equal(dialog.open, true);
  assert.match(image.src, /Tutorial\.gif\?replay=/);
  const first = image.src;
  app.element("replayARScanGuide").emit("click");
  assert.notEqual(image.src, first);
  app.element("finishARScanGuide").emit("click");
  assert.equal(dialog.open, false);
  assert.equal(image.src, "");
});

test("the guide honors reduced motion, supports a still image, and explains an unavailable animation", () => {
  const app = guide(true), image = app.element("arScanGuideImage");
  app.element("openARScanGuide").emit("click");
  assert.match(image.src, /Still\.png$/);
  app.element("toggleARScanGuideMotion").emit("click");
  assert.match(image.src, /Tutorial\.gif/);
  app.media.change();
  assert.match(image.src, /Still\.png$/);
  image.emit("error");
  assert.equal(image.hidden, true);
  assert.equal(app.element("arScanGuideError").hidden, false);
});

test("closing help releases the animation and Escape cannot trigger the classroom's camera shortcut", () => {
  const app = guide(), dialog = app.element("arScanGuide");
  let stopped = false;
  app.element("openARScanGuide").emit("click");
  dialog.emit("keydown", { key: "Escape", stopPropagation() { stopped = true; } });
  assert.equal(stopped, true);
  app.events["imars-session-ended"]();
  assert.equal(dialog.open, false);
  app.element("openARScanGuide").emit("click");
  app.events.pagehide();
  assert.equal(app.element("arScanGuideImage").src, "");
});
