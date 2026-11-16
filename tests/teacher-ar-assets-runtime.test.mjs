import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { readFileSync } from "node:fs";
import { teacherARCatalog } from "../js/teacher-ar-catalog.js";

test("all shipped AR lessons attach indicators to real model surfaces; volcano cutaway retains live eruption clips", async t => {
  const names = ["window", "document", "self", "createImageBitmap", "ProgressEvent", "Image"], previous = new Map(names.map(name => [name, globalThis[name]]));
  t.after(() => { for (const [name, value] of previous) { if (value === undefined) delete globalThis[name]; else globalThis[name] = value; } });
  globalThis.window = { document: {} }; globalThis.document = window.document; globalThis.self = globalThis;
  // Geometry, animation and projection use the actual shipped engine/assets.
  // Textures need no decoded pixels because this test never creates a renderer.
  globalThis.createImageBitmap = async () => ({ width: 2048, height: 2048, close() {} });
  globalThis.Image = class { height = 1; set src(value) { queueMicrotask(() => this.onload?.()); } };
  globalThis.ProgressEvent = class { constructor(type, options) { Object.assign(this, { type }, options); } };
  const { THREE, GLTFLoader } = await import("../js/vendor/teacher-ar-engine.js");
  const context = vm.createContext({ THREE, GLTFLoader, MindARThree: class {}, AbortController,
    document: { createElement: () => ({ style: {}, dataset: {}, setAttribute() {}, addEventListener() {}, remove() {} }) },
    fetch: async url => { const bytes = readFileSync(new URL(`..${url}`, import.meta.url)); return { ok: true, arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) }; } });
  vm.runInContext(readFileSync(new URL("../js/teacher-ar-scene.js", import.meta.url), "utf8").replace(/^import .*;\r?\n/gm, "").replace(/^export /gm, ""), context);
  const Scene = vm.runInContext("TeacherARScene", context);
  let tested = 0;
  for (const item of teacherARCatalog) {
    const camera = new THREE.PerspectiveCamera(38, 1.6, .1, 100); camera.position.set(0, .75, 5); camera.lookAt(0, .75, 0); camera.updateMatrixWorld(true);
    const marker = new THREE.Group(); marker.rotation.x = -Math.PI / 2;
    const scene = Object.assign(Object.create(Scene.prototype), { scene: new THREE.Scene(), generation: 0, highlighted: [], hotspots: [],
      tracker: { camera }, activeAnchor: { modelId: item.id, group: marker }, overlay: { append() {} }, stage: { clientWidth: 800, clientHeight: 500 }, onTracking() {}, draw() {} });
    assert.equal(await scene.load(item), true);
    for (const hotspot of scene.hotspots) {
      assert.ok(hotspot.parts.length, `${item.title}: ${hotspot.label.title} has a model anchor`);
      for (const part of hotspot.parts) {
        assert.ok(part.mesh?.isMesh, `${item.title}: ${hotspot.label.title} attaches to geometry`);
        assert.ok(part.vertexIndex >= 0 && part.vertexIndex < part.mesh.geometry.attributes.position.count);
      }
    }
    for (const seconds of [0, .2, .5]) {
      scene.mixers.forEach(mixer => mixer.update(seconds));
      scene.model.rotation.y += .2; scene.model.scale.setScalar(1 + seconds); marker.updateMatrixWorld(true);
      for (const hotspot of scene.hotspots) for (const part of hotspot.parts) {
        const expected = part.mesh.getVertexPosition(part.vertexIndex, new THREE.Vector3()).applyMatrix4(part.mesh.matrixWorld);
        assert.ok(scene.anchorWorld(part).distanceTo(expected) < 1e-6, `${item.title}: surface point follows the animated mesh`);
      }
    }
    if (item.title === "Volcano") {
      assert.ok(scene.mixers[0]._actions[0]._clip.tracks.length > 10);
      assert.ok(scene.mixers[1]._actions[0]._clip.tracks.length > 10, "interior smoke, fire and lava clips are retained");
      scene.setDissected(true); scene.advanceDissection(.14);
      assert.ok(scene.wholeFrame.rotation.y > 0 && scene.wholeFrame.visible, "opening has visible movement before switching models");
      scene.advanceDissection(.56); assert.equal(scene.cutawayFrame.visible, true);
      let smoke; scene.modelFrames[1].root.traverse(node => { if (!smoke && /^Fire_cloud_/.test(node.name)) smoke = node; });
      assert.ok(smoke); const before = [...smoke.position.toArray(), ...smoke.scale.toArray()];
      scene.mixers[1].update(.6);
      assert.notDeepEqual([...smoke.position.toArray(), ...smoke.scale.toArray()], before, "the visible cutaway eruption continues moving");
    }
    tested++; scene.clearModel();
  }
  assert.equal(tested, 27);
});
