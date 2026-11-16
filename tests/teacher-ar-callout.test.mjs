import assert from "node:assert/strict";
import test from "node:test";
import { descriptionArrow, descriptionPlacement, TeacherARCallout } from "../js/teacher-ar-callout.js";

const frame = { left: 40, top: 80, width: 1000, height: 500 };
const viewport = { left: 40, top: 80, width: 720, height: 500 };
const card = { left: 776, top: 160, width: 248, height: 200 };

test("camera descriptions connect to the projected surface point and follow its position", () => {
  assert.equal(descriptionArrow({ x: 300, y: 220 }, viewport, card, frame), "M736,189 L518,189 L300,220");
  assert.equal(descriptionArrow({ x: 450, y: 180 }, viewport, card, frame), "M736,180 L593,180 L450,180");
  // Page scrolling moves all rectangles together without moving the arrow.
  const scroll = rect => ({ ...rect, top: rect.top - 200 });
  assert.equal(descriptionArrow({ x: 300, y: 220 }, scroll(viewport), scroll(card), scroll(frame)), "M736,189 L518,189 L300,220");
});

test("narrow layouts keep descriptions inside the camera near the opposite edge", () => {
  const mobile = { left: 0, top: 20, width: 390, height: 540 };
  const detail = { left: 210, top: 78, width: 168, height: 190 };
  assert.equal(descriptionArrow({ x: 110, y: 230 }, mobile, detail, mobile), "M210,188 L160,188 L110,230");
  assert.equal(descriptionArrow({ x: 260, y: 100 }, mobile, detail, mobile), null, "never draw an arrow pointing under the card");
  assert.deepEqual(descriptionPlacement({ x: 110, y: 230 }, mobile, detail), { x: 210, y: 145, side: "right" });
  assert.deepEqual(descriptionPlacement({ x: 300, y: 200 }, mobile, detail), { x: 12, y: 115, side: "left" });
  assert.equal(descriptionPlacement({ x: 210, y: 200 }, mobile, detail, "right").side, "right", "small tracking movements must not flip the card repeatedly");
});

test("missing, offscreen, or unmeasurable parts never leave a misleading arrow", () => {
  for (const anchor of [null, { x: NaN, y: 20 }, { x: -1, y: 20 }, { x: 100, y: 501 }]) assert.equal(descriptionArrow(anchor, viewport, card, frame), null);
  assert.equal(descriptionArrow({ x: 200, y: 100 }, viewport, { ...card, width: 0 }, frame), null);
  assert.equal(descriptionArrow({ x: 200, y: 100 }, viewport, { ...card, top: 700 }, frame), null);
});

test("arrow rendering caches layout between frames and refreshes after resize or panel scrolling", () => {
  let resize, reads = 0;
  const previous = globalThis.ResizeObserver;
  globalThis.ResizeObserver = class { constructor(callback) { resize = callback; } observe() {} };
  const node = rect => ({ attributes: new Map(), events: {}, style: {}, getBoundingClientRect() { reads++; return rect; },
    getAttribute(name) { return this.attributes.get(name); }, setAttribute(name, value) { this.attributes.set(name, value); },
    removeAttribute(name) { this.attributes.delete(name); }, addEventListener(name, callback) { this.events[name] = callback; } });
  try {
    const svg = node(), path = node(), rail = node({ left: 760, top: 80, width: 280, height: 400 });
    const callout = new TeacherARCallout({ frame: node(frame), viewport: node(viewport), card: node(card), svg, path, rail });
    callout.setEnabled(true); callout.update({ x: 300, y: 220 });
    assert.equal(svg.attributes.has("hidden"), false); assert.equal(svg.getAttribute("viewBox"), "0 0 1000 500"); assert.equal(reads, 4);
    assert.ok(parseInt(rail.style.left) + 280 <= viewport.width, "the card stays inside the camera viewport");
    callout.update({ x: 450, y: 180 }); assert.equal(reads, 4, "tracking frames must not repeatedly force layout");
    assert.ok(path.getAttribute("d").endsWith("L450,180"));
    resize(); callout.update({ x: 300, y: 220 }); assert.equal(reads, 8);
    rail.events.scroll(); callout.update({ x: 300, y: 220 }); assert.equal(reads, 12);
    callout.update(null); assert.equal(svg.attributes.has("hidden"), true);
    callout.update({ x: 300, y: 220 }); callout.setEnabled(false); assert.equal(svg.attributes.has("hidden"), true);
  } finally { if (previous === undefined) delete globalThis.ResizeObserver; else globalThis.ResizeObserver = previous; }
});
