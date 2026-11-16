import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { readFileSync, existsSync } from "node:fs";
import { teacherARCatalog } from "../js/teacher-ar-catalog.js";
import { onRequest, CONTENT_SECURITY_POLICY } from "../functions/_middleware.js";

test("all 27 app markers have compiled tracking targets, embedded 3D models, and original teaching descriptions", () => {
  assert.equal(teacherARCatalog.length, 27);
  assert.equal(new Set(teacherARCatalog.map(item => item.id)).size, 27);
  const files = new Set();
  for (const item of teacherARCatalog) {
    assert.ok(item.title && item.topic && item.markerName);
    assert.ok(item.labels.length);
    for (const path of [item.marker, item.target, ...item.models.map(model => model.url), ...item.labels.map(label => label.audio).filter(Boolean)]) {
      assert.match(path, /^\/assets\/(teacher-ar|showcase)\/[a-z0-9.-]+$/);
      assert.ok(existsSync(new URL(`..${path}`, import.meta.url)), path);
      files.add(path);
    }
    const target = readFileSync(new URL(`..${item.target}`, import.meta.url));
    assert.equal(target[0], 0x82, "MindAR target is a MessagePack map");
    assert.ok(target.includes(Buffer.from("dataList")));
    for (const model of item.models) {
      const bytes = readFileSync(new URL(`..${model.url}`, import.meta.url));
      assert.equal(bytes.toString("ascii", 0, 4), "glTF");
      assert.equal(bytes.readUInt32LE(4), 2);
      const json = JSON.parse(bytes.toString("utf8", 20, 20 + bytes.readUInt32LE(12)));
      assert.ok(json.scenes.length && json.meshes.length);
      for (const buffer of json.buffers || []) assert.ok(!buffer.uri || buffer.uri.startsWith("data:"));
      for (const image of json.images || []) assert.ok(!image.uri || image.uri.startsWith("data:"));
      assert.ok(!(json.extensionsRequired || []).some(name => /draco|meshopt/i.test(name)), "models work without external geometry decoders");
    }
    for (const label of item.labels) {
      assert.ok(label.title && label.description && label.audio);
      assert.ok(label.parts.length);
    }
  }
  assert.ok(files.size > 100, "complete original marker and narration set is included");
});

function trackerHarness(getUserMedia) {
  const events = {}, video = { remove() { this.removed = true; }, play: async () => {},
    set srcObject(value) { this.stream = value; queueMicrotask(() => this.onloadedmetadata()); }, get srcObject() { return this.stream; } };
  const context = vm.createContext({ MindARThree: class {}, THREE: {}, navigator: { mediaDevices: { getUserMedia } },
    DOMException, setTimeout: () => 1, clearTimeout() {}, queueMicrotask,
    document: { createElement: () => video }, window: { removeEventListener: (name, fn) => { events[name] = fn; } } });
  vm.runInContext(readFileSync(new URL("../js/teacher-ar-scene.js", import.meta.url), "utf8").replace(/^import .*;\r?\n/gm, "").replace(/^export /gm, ""), context);
  const Tracker = vm.runInContext("TeacherMarkerTracker", context);
  const tracker = new Tracker(); tracker.container = { prepend() {} };
  return { tracker, video, events };
}

test("leaving during camera permission stops every track from a late permission grant", async () => {
  let grant, stopped = 0;
  const { tracker } = trackerHarness(() => new Promise(resolve => { grant = resolve; }));
  const start = tracker._startVideo();
  tracker.close();
  grant({ getTracks: () => [{ stop() { stopped++; } }, { stop() { stopped++; } }] });
  await assert.rejects(start, { name: "AbortError" });
  assert.equal(stopped, 2);
});

test("camera startup requests no microphone and closing releases its stream", async () => {
  let constraints, stopped = 0;
  const stream = { getTracks: () => [{ stop() { stopped++; } }] };
  const { tracker, video } = trackerHarness(async options => { constraints = options; return stream; });
  await tracker._startVideo();
  assert.equal(constraints.audio, false);
  assert.equal(constraints.video.facingMode, "environment");
  tracker.close();
  assert.equal(stopped, 1); assert.equal(video.removed, true);
});

test("camera permission errors remain actionable", async () => {
  const error = new DOMException("Denied", "NotAllowedError");
  const { tracker } = trackerHarness(async () => { throw error; });
  await assert.rejects(tracker._startVideo(), { name: "NotAllowedError" });
});

function classroom() {
  class Element {
    events = {}; children = []; attributes = new Map(); dataset = {}; value = ""; hidden = false; disabled = true; paused = true;
    classList = { values: new Set(), toggle(name, yes) { if (yes) this.values.add(name); else this.values.delete(name); } };
    addEventListener(name, callback) { this.events[name] = callback; }
    emit(name, event = {}) { return this.events[name]?.(event); }
    append(node) { this.children.push(node); }
    add(node) { this.children.push(node); if (!this.value) this.value = node.value; }
    replaceChildren() { this.children = []; this.value = ""; }
    querySelectorAll() { return this.children; }
    setAttribute(key, value) { this.attributes.set(key, value); }
    getAttribute(key) { return this.attributes.get(key); }
    removeAttribute(key) { this.attributes.delete(key); }
    set src(value) { this.attributes.set("src", value); }
    pause() { this.paused = true; this.emit("pause"); }
    async play() { this.paused = false; this.emit("play"); }
    load() {}
  }
  const nodes = new Map(), element = id => { if (!nodes.has(id)) nodes.set(id, new Element()); return nodes.get(id); };
  element("arQuality").value = "medium";
  const document = { events: {}, visibilityState: "visible", body: new Element(), getElementById: element,
    createElement: () => new Element(), addEventListener(name, callback) { this.events[name] = callback; } };
  const window = { events: {}, isSecureContext: true, location: { search: "" }, addEventListener(name, callback) { this.events[name] = callback; } };
  let authChanged, scenes = [], engineLoads = 0;
  class Scene {
    constructor(options) { this.options = options; this.animated = true; scenes.push(this); }
    async load(item) { this.item = item; return true; }
    setLabels(value) { this.labelsVisible = value; } setQuality(value) { this.quality = value; }
    setPaused(value) { this.paused = value; } setZoom(value) { this.zoom = value; }
    selectLabel(value) { this.label = value; } reset() {} resize() {}
    async startScanning() { this.tracker = { stream: { getVideoTracks: () => [{ getSettings: () => ({ deviceId: "camera" }), getCapabilities: () => ({}) }] } }; return true; }
    stopScanning() { this.tracker = null; this.stops = (this.stops || 0) + 1; }
    dispose() { this.disposed = true; this.stopScanning(); }
  }
  const context = vm.createContext({ document, window, teacherARCatalog, initializeApp: () => ({}), getAuth: () => ({}),
    onAuthStateChanged: (_, callback) => { authChanged = callback; },
    loadEngine: async () => { engineLoads++; return { TeacherARScene: Scene }; },
    navigator: { mediaDevices: { getUserMedia() {}, enumerateDevices: async () => [{ kind: "videoinput", deviceId: "camera" }] } },
    Option: function(text, value) { this.textContent = text; this.value = value; }, URLSearchParams, console,
    setTimeout: () => 1 });
  vm.runInContext(readFileSync(new URL("../js/teacher-ar.js", import.meta.url), "utf8").replace(/^import .*;\r?\n/gm, "").replace('import("./teacher-ar-scene.js")', "loadEngine()"), context);
  return { element, document, window, scenes, authChanged: user => authChanged(user), engineLoads: () => engineLoads,
    settle: async () => { await new Promise(resolve => setImmediate(resolve)); } };
}

test("teacher presentation controls work without starting a camera or saving student progress", async () => {
  const page = classroom();
  assert.equal(page.engineLoads(), 0);
  page.authChanged({ uid: "teacher-1", role: "teacher" }); await page.settle();
  const scene = page.scenes[0];
  assert.ok(scene.item); assert.equal(scene.tracker, undefined, "preview never starts the camera");
  assert.equal(page.element("arScan").disabled, false);
  page.element("arPause").emit("click"); assert.equal(scene.paused, true);
  page.element("arPause").emit("click"); assert.equal(scene.paused, false);
  page.element("arLabels").emit("click"); assert.equal(scene.labelsVisible, true);
  page.element("arPresentation").emit("click"); assert.equal(scene.presenting, true);
  page.document.events.keydown({ key: "Escape" }); assert.equal(scene.presenting, false);
  const part = page.element("arParts").children[0]; part.emit("click");
  assert.equal(scene.label, scene.item.labels[0].id);
  assert.equal(page.element("arDescriptionText").textContent, scene.item.labels[0].description);
  await page.element("arNarration").emit("click"); assert.equal(page.element("arAudio").paused, false);
  page.element("arMute").emit("click"); assert.equal(page.element("arAudio").paused, true);
  assert.equal(page.element("arNarration").disabled, true);
  page.element("arFullModel").emit("click"); assert.equal(scene.label, null);
  assert.equal(page.element("arDescription").hidden, true);
  assert.equal(page.document.body.classList.values.has("ar-presenting"), false);
});

test("hidden pages and sign-out stop the teacher camera and dispose the old classroom", async () => {
  const page = classroom(); page.authChanged({ uid: "teacher-1", role: "teacher" }); await page.settle();
  const scene = page.scenes[0];
  page.element("arScan").emit("click"); await page.settle();
  assert.ok(scene.tracker);
  page.document.visibilityState = "hidden"; page.document.events.visibilitychange();
  assert.equal(scene.tracker, null);
  page.document.visibilityState = "visible";
  page.element("arScan").emit("click"); await page.settle(); assert.ok(scene.tracker);
  page.authChanged(null); assert.equal(scene.tracker, null); assert.equal(scene.disposed, true);
  assert.equal(page.element("arScan").disabled, true);
});

test("student and admin accounts never initialize the teacher classroom", async () => {
  for (const role of ["student", "admin"]) {
    const page = classroom(); page.authChanged({ uid: "other", role }); await page.settle();
    assert.equal(page.engineLoads(), 0); assert.equal(page.element("arScan").disabled, true);
  }
});

test("AR textures can load local blobs while camera and script policies stay restricted", async () => {
  const response = await onRequest({ env: {}, request: new Request("https://imars.test/teacher-ar"), next: async () => new Response("page") });
  assert.equal(response.headers.get("Content-Security-Policy"), CONTENT_SECURITY_POLICY.replace("connect-src 'self'", "connect-src 'self' blob:"));
  assert.match(response.headers.get("Permissions-Policy"), /camera=\(self\), microphone=\(\)/);
  assert.ok(!response.headers.get("Content-Security-Policy").includes("'unsafe-eval'"));
});
