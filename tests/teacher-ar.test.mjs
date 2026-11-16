import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { readFileSync, existsSync } from "node:fs";
import { teacherARCatalog, teacherARScanner } from "../js/teacher-ar-catalog.js";
import { TeacherARNarration } from "../js/teacher-ar-narration.js";
import { onRequest, CONTENT_SECURITY_POLICY } from "../functions/_middleware.js";

test("all 27 app markers have compiled tracking targets, embedded 3D models, and original teaching descriptions", () => {
  assert.equal(teacherARCatalog.length, 27);
  assert.equal(new Set(teacherARCatalog.map(item => item.id)).size, 27);
  assert.ok(existsSync(new URL(`..${teacherARScanner.target}`, import.meta.url)));
  assert.equal(teacherARScanner.targetModels.length, teacherARCatalog.reduce((count, item) => count + item.targetCount, 0));
  assert.deepEqual(new Set(teacherARScanner.targetModels), new Set(teacherARCatalog.map(item => item.id)), "one scanner covers every model without a lesson selector");
  const files = new Set();
  for (const item of teacherARCatalog) {
    assert.ok(item.title && item.topic && item.markerName);
    assert.ok(item.labels.length);
    assert.ok(item.targetCount >= 1 && item.markerSources.length);
    for (const path of [item.marker, item.target, ...item.models.map(model => model.url), ...item.labels.flatMap(label => [label.audio, label.interactiveAudio]).filter(Boolean)]) {
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
      assert.ok(label.interactiveAudio && label.question && label.answer && label.answerStart > 0, "current mobile question/answer narration is included");
      let before = -1;
      for (const cue of label.descriptionCues) { assert.ok(cue.text && cue.start >= before); before = cue.start; }
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
  return { tracker, video, events, tune: vm.runInContext("tuneTrackingCamera", context) };
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
  assert.equal(constraints.video.width.ideal, 1280);
  assert.equal(constraints.video.height.ideal, 720);
  assert.equal(constraints.video.frameRate.ideal, 30);
  assert.equal(constraints.video.width.exact, undefined, "older webcams may negotiate a lower resolution");
  tracker.close();
  assert.equal(stopped, 1); assert.equal(video.removed, true);
});

test("camera autofocus is requested only when supported and tuning failures do not stop scanning", async () => {
  const { tune } = trackerHarness(async () => ({}));
  let request;
  await tune({ getVideoTracks: () => [{ getCapabilities: () => ({ focusMode: ["continuous"], exposureMode: ["manual"] }), applyConstraints: async value => { request = value; } }] });
  assert.equal(request.advanced[0].focusMode, "continuous");
  assert.equal(request.advanced[0].exposureMode, undefined);
  await assert.doesNotReject(tune({ getVideoTracks: () => [{ getCapabilities: () => ({ focusMode: ["continuous"] }), applyConstraints: async () => { throw Error("Driver rejected optional focus"); } }] }));
});

test("camera permission errors remain actionable", async () => {
  const error = new DOMException("Denied", "NotAllowedError");
  const { tracker } = trackerHarness(async () => { throw error; });
  await assert.rejects(tracker._startVideo(), { name: "NotAllowedError" });
});

function markerScene() {
  let scene;
  const renderer = () => ({ domElement: { style: {}, hidden: false, remove() {} }, clears: 0,
    clear() { this.clears++; }, setAnimationLoop(callback) { this.loop = callback; },
    setPixelRatio() {}, dispose() {}, render() { this.lastModelVisible = scene.model.visible; } });
  const context = vm.createContext({ THREE: {}, devicePixelRatio: 1, setTimeout: () => 1,
    document: { visibilityState: "visible" }, window: { removeEventListener() {} },
    MindARThree: class {
      constructor(options) { this.options = options; this.anchors = []; this.renderer = renderer(); this.cssRenderer = { domElement: { remove() {} } }; this.scene = {}; this.camera = {}; }
      async start() {}
      addAnchor(index) {
        this.anchor = { targetIndex: index, group: { visible: false, add(model) { model.parent = this; } } };
        this.anchors.push(this.anchor);
        return this.anchor;
      }
    } });
  vm.runInContext(readFileSync(new URL("../js/teacher-ar-scene.js", import.meta.url), "utf8").replace(/^import .*;\r?\n/gm, "").replace(/^export /gm, ""), context);
  const Scene = vm.runInContext("TeacherARScene", context);
  const tracking = [];
  scene = Object.assign(Object.create(Scene.prototype), {
    stage: {}, scanGeneration: 0,
    item: { id: "model-1" }, model: { visible: false, rotation: { x: 0 } }, quality: "medium",
    scene: { add(model) { model.parent = this; } }, camera: {}, clock: { getDelta: () => .016 }, mixers: [],
    onTracking: found => tracking.push(found), lights() {}, reset() {}, resize() {}, positionHotspots() {}
  });
  return { scene, tracking, scanner: { target: "/assets/teacher-ar/example.mind", targetModels: ["model-1"] } };
}

test("automatic scan mode shows no model until its marker is recognized", async () => {
  const { scene, scanner } = markerScene();
  await scene.startScanning(undefined, scanner);
  const tracker = scene.tracker;
  assert.equal(tracker.options.warmupTolerance, 1, "confirmation needs two valid tracked frames instead of six");
  assert.equal(scene.model.visible, false);
  scene.draw(); assert.equal(tracker.renderer.lastModelVisible, false);
  tracker.anchor.group.visible = true; tracker.anchor.onTargetFound();
  scene.draw(); assert.equal(tracker.renderer.lastModelVisible, true);
  tracker.anchor.group.visible = false; tracker.anchor.onTargetLost();
  assert.equal(scene.model.visible, false);
  assert.ok(tracker.renderer.clears > 0, "the last tracked frame disappears immediately on loss");
  scene.draw(); assert.equal(tracker.renderer.lastModelVisible, false);
  tracker.anchor.group.visible = true; tracker.anchor.onTargetFound();
  scene.draw(); assert.equal(tracker.renderer.lastModelVisible, true, "reacquisition restores the model");
});

test("downloaded and app marker variants attach to their own pose without stale loss hiding the active model", async () => {
  const { scene, scanner } = markerScene(); scanner.targetModels = ["model-1", "model-1", "model-1"];
  await scene.startScanning(undefined, scanner);
  const tracker = scene.tracker;
  assert.equal(tracker.anchors.length, 3); assert.equal(scene.model.visible, false);
  const first = tracker.anchors[0], printed = tracker.anchors[1];
    first.onTargetFound(); assert.equal(scene.model.parent, first.group);
  printed.onTargetFound(); assert.equal(scene.model.parent, printed.group);
  first.onTargetLost(); assert.equal(scene.model.visible, true);
  printed.onTargetLost(); assert.equal(scene.model.visible, false);
});

test("teacher classroom has no manual model selectors, preview, camera-switch or flashlight controls", () => {
  const html = readFileSync(new URL("../teacher-ar.html", import.meta.url), "utf8");
  assert.doesNotMatch(html, /arSwitchCamera|arTorch|arPreview|id="arTopic"|id="arModel"/);
});

test("refresh ignores old tracking callbacks and stopping never reveals a standalone model", async () => {
  const { scene, scanner } = markerScene();
  await scene.startScanning(undefined, scanner); const previous = scene.tracker;
  previous.anchor.onTargetFound(); assert.equal(scene.model.visible, true);
  await scene.startScanning(undefined, scanner);
  assert.equal(scene.model.visible, false);
  previous.anchor.onTargetFound(); assert.equal(scene.model.visible, false, "stale recognition cannot reveal the new scan");
  scene.stopScanning();
  assert.equal(scene.model.visible, false);
  scene.draw(); assert.equal(scene.model.visible, false);
});

test("teaching labels stay steady through mesh animation but follow model rotation and zoom", async () => {
  // Use the shipped engine's actual vector, bounds and projection math without
  // constructing a renderer or opening a camera.
  const previousWindow = globalThis.window, previousDocument = globalThis.document;
  let THREE;
  try {
    globalThis.window = { document: {} }; globalThis.document = globalThis.window.document;
    ({ THREE } = await import("../js/vendor/teacher-ar-engine.js"));
  } finally {
    if (previousWindow === undefined) delete globalThis.window; else globalThis.window = previousWindow;
    if (previousDocument === undefined) delete globalThis.document; else globalThis.document = previousDocument;
  }
  const context = vm.createContext({ THREE, MindARThree: class {}, document: { createElement: () => ({ style: {}, addEventListener() {} }) } });
  vm.runInContext(readFileSync(new URL("../js/teacher-ar-scene.js", import.meta.url), "utf8").replace(/^import .*;\r?\n/gm, "").replace(/^export /gm, ""), context);
  const Scene = vm.runInContext("TeacherARScene", context);
  const model = new THREE.Group(), content = new THREE.Group(); model.add(content);
  const part = new THREE.Mesh(new THREE.BoxGeometry(.3, .3, .3), new THREE.MeshBasicMaterial());
  part.name = "Animated rain"; part.position.set(.8, .3, .1); content.add(part);
  const camera = new THREE.PerspectiveCamera(38, 2, .1, 100);
  camera.position.set(0, 0, 8); camera.lookAt(0, 0, 0); camera.updateMatrixWorld(true);
  const scene = Object.assign(Object.create(Scene.prototype), { model, content, tracker: { camera }, tracked: true, labelsVisible: true,
    stage: { clientWidth: 1000, clientHeight: 500 }, overlay: { append() {} } });
  scene.buildHotspots([{ id: "rain", title: "Precipitation", parts: [{ path: part.name, point: { x: 0, y: 0, z: 0 } }] }]);
  const position = () => { scene.positionHotspots(); return { ...scene.hotspots[0].button.style }; };
  const first = position();
  part.position.set(-.5, -1, .2); part.scale.setScalar(.2); part.updateMatrixWorld(true);
  assert.deepEqual(position(), first, "animated child transforms must not shake the teaching label");
  model.rotation.z = Math.PI / 4; model.updateMatrixWorld(true);
  const rotated = position(); assert.notDeepEqual(rotated, first, "rotating the complete model moves its label with it");
  model.scale.setScalar(1.5); model.updateMatrixWorld(true);
  assert.notDeepEqual(position(), rotated, "zooming the complete model moves its label with it");
  assert.match(first.left, /^\d+px$/); assert.match(first.top, /^\d+px$/);
  part.geometry.dispose(); part.material.dispose();
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
    constructor(options) { this.options = options; this.animated = true; this.generation = 0; this.loads = []; this.starts = 0; scenes.push(this); }
    async load(item) { this.item = item; this.loads.push(item.id); this.model = {}; this.tracked = item.id === this.detected; this.options.onTracking(this.tracked); return true; }
    detect(id) { this.detected = id; this.tracked = Boolean(this.model && this.item.id === id); this.options.onTracking(this.tracked); this.options.onModelDetected(id); }
    clearModel() { this.model = null; }
    setLabels(value) { this.labelsVisible = value; } setQuality(value) { this.quality = value; }
    setPaused(value) { this.paused = value; } setZoom(value) { this.zoom = value; }
    selectLabel(value) { this.label = value; } reset() {} resize() {}
    async startScanning(device, scanner) { this.scanner = scanner; this.starts++; this.tracker = { stream: { getVideoTracks: () => [{ getSettings: () => ({ deviceId: "camera" }) }] } }; return true; }
    stopScanning() { this.tracker = null; this.tracked = false; this.stops = (this.stops || 0) + 1; this.options.onTracking(false); }
    dispose() { this.disposed = true; this.stopScanning(); }
  }
  const context = vm.createContext({ document, window, teacherARCatalog, teacherARScanner, TeacherARNarration, initializeApp: () => ({}), getAuth: () => ({}),
    onAuthStateChanged: (_, callback) => { authChanged = callback; },
    loadEngine: async () => { engineLoads++; return { TeacherARScene: Scene }; },
    navigator: { mediaDevices: { getUserMedia() {}, enumerateDevices: async () => [{ kind: "videoinput", deviceId: "camera" }] } },
    Option: function(text, value) { this.textContent = text; this.value = value; }, URLSearchParams, console,
    setTimeout: () => 1 });
  vm.runInContext(readFileSync(new URL("../js/teacher-ar.js", import.meta.url), "utf8").replace(/^import .*;\r?\n/gm, "").replace('import("./teacher-ar-scene.js")', "loadEngine()"), context);
  return { element, document, window, scenes, authChanged: user => authChanged(user), engineLoads: () => engineLoads,
    settle: async () => { await new Promise(resolve => setImmediate(resolve)); } };
}

test("scan-only classroom loads models automatically and keeps teacher controls and label narration", async () => {
  const page = classroom();
  assert.equal(page.engineLoads(), 0);
  page.authChanged({ uid: "teacher-1", role: "teacher" }); await page.settle();
  assert.equal(page.engineLoads(), 0); assert.equal(page.scenes.length, 0, "opening the classroom loads no preview model or renderer");
  page.element("arScan").emit("click"); await page.settle();
  const scene = page.scenes[0];
  const tracker = scene.tracker;
  assert.ok(tracker); assert.equal(scene.model, undefined); assert.equal(scene.scanner, teacherARScanner);
  assert.equal(page.element("arPause").disabled, true, "controls await a detected model");
  const pulley = teacherARCatalog.find(item => item.title === "Pulley");
  scene.detect(pulley.id); await page.settle();
  assert.equal(scene.item, pulley); assert.equal(page.element("arTitle").textContent, "Pulley");
  assert.equal(page.element("arPause").disabled, false);
  page.element("arPause").emit("click"); assert.equal(scene.paused, true);
  page.element("arPause").emit("click"); assert.equal(scene.paused, false);
  page.element("arLabels").emit("click"); assert.equal(scene.labelsVisible, true);
  page.element("arPresentation").emit("click"); assert.equal(scene.presenting, true);
  page.document.events.keydown({ key: "Escape" }); assert.equal(scene.presenting, false);
  const part = page.element("arParts").children[0]; part.emit("click");
  assert.equal(scene.label, scene.item.labels[0].id);
  assert.equal(page.element("arDescriptionText").textContent, scene.item.labels[0].description);
  assert.equal(page.element("arAudio").paused, false, "selecting the label starts its narration immediately");
  await page.element("arNarration").emit("click"); assert.equal(page.element("arAudio").paused, true);
  await page.element("arNarration").emit("click"); assert.equal(page.element("arAudio").paused, false);
  assert.equal(page.element("arSubtitles").hidden, false);
  const lever = teacherARCatalog.find(item => item.title === "Lever");
  scene.detect(lever.id); await page.settle();
  assert.equal(scene.item, lever); assert.equal(scene.tracker, tracker); assert.equal(scene.starts, 1, "another marker changes models without restarting the camera");
  assert.equal(page.element("arTitle").textContent, "Lever");
  assert.equal(page.element("arAudio").paused, true); assert.equal(page.element("arSubtitles").hidden, true);
  page.element("arParts").children[0].emit("click");
  page.element("arMute").emit("click"); assert.equal(page.element("arAudio").paused, true);
  assert.equal(page.element("arNarration").disabled, true);
  page.element("arFullModel").emit("click"); assert.equal(scene.label, null);
  assert.equal(page.element("arDescription").hidden, true);
  assert.equal(page.document.body.classList.values.has("ar-presenting"), false);
});

test("hidden pages and sign-out stop the teacher camera and dispose the old classroom", async () => {
  const page = classroom(); page.authChanged({ uid: "teacher-1", role: "teacher" }); await page.settle();
  page.element("arScan").emit("click"); await page.settle();
  const scene = page.scenes[0];
  assert.ok(scene.tracker);
  page.document.visibilityState = "hidden"; page.document.events.visibilitychange();
  assert.equal(scene.tracker, null);
  page.document.visibilityState = "visible";
  page.element("arScan").emit("click"); await page.settle(); assert.ok(scene.tracker);
  page.authChanged(null); assert.equal(scene.tracker, null); assert.equal(scene.disposed, true);
  assert.equal(page.element("arScan").disabled, true);
});

test("hiding the classroom during engine loading cancels the pending camera start", async () => {
  const page = classroom(); page.authChanged({ uid: "teacher-1", role: "teacher" });
  page.element("arScan").emit("click");
  page.document.visibilityState = "hidden"; page.document.events.visibilitychange();
  await page.settle();
  assert.equal(page.scenes[0]?.tracker, undefined);
  assert.equal(page.scenes[0]?.starts || 0, 0);
  assert.equal(page.element("arMode").textContent, "Camera off");
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
