// Loaded only when a signed-in teacher opens the AR classroom.
import { THREE, GLTFLoader, OrbitControls, MindARThree } from "./vendor/teacher-ar-engine.js";

export function stopCameraTracks(stream) {
  stream?.getTracks().forEach(track => track.stop());
}

// Own the stream even while permission or startup is pending, so leaving the page
// cannot leave a late camera request running in the background.
export class TeacherMarkerTracker extends MindARThree {
  async _startVideo() {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: this.deviceId
      ? { deviceId: { exact: this.deviceId } } : { facingMode: "environment" } });
    if (this.closed) { stopCameraTracks(stream); throw new DOMException("Camera closed", "AbortError"); }
    this.stream = stream;
    const video = document.createElement("video");
    this.video = video;
    video.muted = true; video.autoplay = true; video.playsInline = true;
    video.className = "teacher-ar-camera";
    this.container.prepend(video);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("The camera did not start. Please try again.")), 15000);
      video.onloadedmetadata = () => { clearTimeout(timer); resolve(); };
      video.onerror = () => { clearTimeout(timer); reject(new Error("The camera could not be opened.")); };
      video.srcObject = stream;
    });
    if (this.closed) { stopCameraTracks(stream); throw new DOMException("Camera closed", "AbortError"); }
    await video.play();
  }
  resize() { if (this.controller && this.video && !this.closed) super.resize(); }
  close() {
    if (this.closed) { stopCameraTracks(this.stream || this.video?.srcObject); return; }
    this.closed = true;
    this.controller?.stopProcessVideo();
    stopCameraTracks(this.stream || this.video?.srcObject);
    this.video?.remove();
    this.renderer?.setAnimationLoop(null);
    this.renderer?.dispose();
    this.renderer?.domElement.remove();
    this.cssRenderer?.domElement.remove();
    window.removeEventListener("resize", this.boundResize);
    this.ui?.hideLoading(); this.ui?.hideScanning(); this.ui?.hideCompatibility();
    // Let a pending tracking response finish before releasing its worker/tensors.
    const controller = this.controller;
    setTimeout(() => {
      controller?.worker?.terminate();
      for (const key of ["featurePointsListT", "imagePixelsListT", "imagePropertiesListT"]) {
        controller?.tracker?.[key]?.forEach(tensor => tensor.dispose());
      }
      const handle = controller?.inputLoader?.tempPixelHandle;
      if (handle) window.MINDAR?.IMAGE?.tf?.backend()?.disposeData(handle.dataId);
    }, 300);
  }
}

const safeName = name => THREE.PropertyBinding.sanitizeNodeName(name || "").toLowerCase();
export class TeacherARScene {
  constructor({ stage, overlay, onStatus, onTracking, onSelect }) {
    Object.assign(this, { stage, overlay, onStatus, onTracking, onSelect });
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(38, 1, .01, 100);
    this.camera.position.set(2.5, 1.7, 2.5);
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.domElement.className = "teacher-ar-canvas";
    stage.prepend(this.renderer.domElement);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.minDistance = .5; this.controls.maxDistance = 8;
    this.controls.target.set(0, .45, 0);
    this.lights(this.scene);
    this.clock = new THREE.Clock();
    this.paused = false; this.zoom = 1; this.highlighted = []; this.hotspots = [];
    this.generation = 0; this.scanGeneration = 0;
    this.pointers = new Map();
    this.abort = new AbortController();
    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(stage);
    for (const name of ["pointerdown", "pointermove", "pointerup", "pointercancel"]) {
      stage.addEventListener(name, event => this.pointer(event), { signal: this.abort.signal });
    }
    this.renderer.setAnimationLoop(() => this.draw());
    this.resize();
  }
  lights(scene) {
    scene.add(new THREE.HemisphereLight(0xffffff, 0x7a8ea5, 2.5));
    const light = new THREE.DirectionalLight(0xffffff, 3);
    light.position.set(2, 4, 3); scene.add(light);
  }
  resize() {
    const width = this.stage.clientWidth, height = this.stage.clientHeight;
    if (!width || !height) return;
    this.camera.aspect = width / height; this.camera.updateProjectionMatrix();
    this.renderer.setSize(width, height);
    this.tracker?.resize();
  }
  async load(item) {
    this.stopScanning();
    this.modelAbort?.abort(); this.modelAbort = new AbortController();
    const signal = this.modelAbort.signal;
    const generation = ++this.generation;
    this.clearModel(); this.item = item; this.paused = false; this.zoom = 1;
    const loader = new GLTFLoader(), results = [];
    try {
      // Load models one by one to limit peak memory on classroom phones.
      for (const asset of item.models) {
        const response = await fetch(asset.url, { signal });
        if (!response.ok) throw new Error("The model could not be loaded. Please try again.");
        const gltf = await loader.parseAsync(await response.arrayBuffer(), "");
        results.push(gltf);
        if (this.closed || generation !== this.generation) { results.forEach(result => this.disposeObject(result.scene)); return false; }
      }
    } catch (error) { results.forEach(result => this.disposeObject(result.scene)); throw error; }
    this.model = new THREE.Group();
    this.content = new THREE.Group(); this.model.add(this.content);
    this.mixers = [];
    results.forEach((gltf, index) => {
      const box = new THREE.Box3().setFromObject(gltf.scene), size = box.getSize(new THREE.Vector3());
      const scale = 1.35 / Math.max(size.x, size.y, size.z, .001);
      const frame = new THREE.Group();
      frame.scale.setScalar(scale);
      const center = box.getCenter(new THREE.Vector3());
      gltf.scene.position.sub(new THREE.Vector3(center.x, box.min.y, center.z));
      frame.add(gltf.scene);
      if (results.length > 1) frame.position.set((index % 2 - .5) * 1.6, 0, Math.floor(index / 2) * 1.6 - .8);
      this.content.add(frame);
      const mixer = new THREE.AnimationMixer(gltf.scene);
      // GLB tracks and clips come from the original teaching models.
      gltf.animations.forEach(clip => mixer.clipAction(clip).play());
      this.mixers.push(mixer);
    });
    const combined = new THREE.Box3().setFromObject(this.content), size = combined.getSize(new THREE.Vector3());
    const scale = 1.5 / Math.max(size.x, size.y, size.z, .001);
    this.content.scale.setScalar(scale);
    this.scene.add(this.model);
    this.animated = results.some(result => result.animations.length);
    this.buildHotspots(item.labels);
    this.reset(); this.draw();
    return true;
  }
  findPart(part) {
    const name = safeName(part.path?.split("/").pop());
    if (!name || name === "node_0") return this.content;
    let found;
    this.content.traverse(node => { if (!found && safeName(node.name) === name) found = node; });
    return found;
  }
  buildHotspots(labels) {
    this.model.updateMatrixWorld(true);
    this.hotspots = labels.map(label => {
      const parts = label.parts.map(part => ({ node: this.findPart(part), point: part.point })).filter(part => part.node);
      parts.forEach(part => {
        const box = new THREE.Box3().setFromObject(part.node).applyMatrix4(part.node.matrixWorld.clone().invert());
        const extent = box.getSize(new THREE.Vector3()).multiplyScalar(.5);
        part.localPoint = box.getCenter(new THREE.Vector3()).add(new THREE.Vector3(part.point.x, part.point.y, part.point.z).multiply(extent));
        // Rain, clouds, waves and moving machine parts animate independently.
        // Keep the teaching label in the model's rigid frame, like the app's
        // frozen animation anchors, rather than following each animated mesh.
        part.modelPoint = this.model.worldToLocal(part.node.localToWorld(part.localPoint.clone()));
      });
      const button = document.createElement("button");
      button.type = "button"; button.className = "teacher-ar-hotspot"; button.textContent = label.title;
      button.hidden = true;
      button.addEventListener("click", event => { event.stopPropagation(); this.onSelect(label.id); });
      this.overlay.append(button);
      return { label, parts, button };
    });
  }
  setLabels(visible) { this.labelsVisible = visible; this.positionHotspots(); }
  positionHotspots() {
    if (!this.model) return;
    const ar = Boolean(this.tracker), camera = this.tracker?.camera || this.camera;
    for (const hotspot of this.hotspots) {
      const part = hotspot.parts[0];
      const visible = this.labelsVisible && !this.presenting && (!ar || this.tracked) && Boolean(part);
      hotspot.button.hidden = !visible;
      if (!visible) continue;
      const point = this.model.localToWorld(part.modelPoint.clone());
      point.project(camera);
      hotspot.button.hidden = point.z < -1 || point.z > 1 || Math.abs(point.x) > 1 || Math.abs(point.y) > 1;
      hotspot.button.style.left = `${Math.round((point.x + 1) * this.stage.clientWidth / 2)}px`;
      hotspot.button.style.top = `${Math.round((1 - point.y) * this.stage.clientHeight / 2)}px`;
    }
  }
  selectLabel(id) {
    this.restoreHighlight();
    const hotspot = this.hotspots.find(item => item.label.id === id);
    for (const part of hotspot?.parts || []) {
      if (part.node === this.content) continue;
      part.node.traverse(node => {
        if (!node.isMesh || !node.material || this.highlighted.some(entry => entry.node === node)) return;
        const original = node.material;
        const highlight = material => {
          const clone = material.clone();
          if (clone.emissive) { clone.emissive.set(0x1258ac); clone.emissiveIntensity = .5; }
          return clone;
        };
        node.material = Array.isArray(original) ? original.map(highlight) : highlight(original);
        this.highlighted.push({ node, original });
      });
    }
  }
  restoreHighlight() {
    for (const { node, original } of this.highlighted) {
      for (const material of Array.isArray(node.material) ? node.material : [node.material]) material.dispose();
      node.material = original;
    }
    this.highlighted = [];
  }
  reset() {
    if (!this.model) return;
    this.model.rotation.set(this.tracker ? Math.PI / 2 : 0, 0, 0);
    this.zoom = 1; this.model.scale.setScalar(1);
    this.camera.position.set(2.5, 1.7, 2.5); this.controls.target.set(0, .45, 0); this.controls.update();
    this.restoreHighlight();
  }
  setZoom(value) { this.zoom = Math.max(.5, Math.min(2, Number(value) || 1)); this.model?.scale.setScalar(this.zoom); }
  rotate(direction) { if (this.model) this.model.rotateY(direction * Math.PI / 12); }
  setPaused(value) { this.paused = value; this.clock.getDelta(); }
  setQuality(value) {
    const ratio = Math.min(devicePixelRatio, value === "low" ? 1 : value === "high" ? 2 : 1.5);
    this.renderer.setPixelRatio(ratio); this.tracker?.renderer.setPixelRatio(ratio); this.resize();
  }
  async startScanning(deviceId) {
    if (!this.model || this.closed) return;
    this.stopScanning();
    const generation = ++this.scanGeneration;
    const tracker = new TeacherMarkerTracker({ container: this.stage, imageTargetSrc: this.item.target,
      maxTrack: 1, uiLoading: "no", uiScanning: "no", uiError: "no", warmupTolerance: 5, missTolerance: 8 });
    this.tracker = tracker; tracker.deviceId = deviceId;
    tracker.renderer.domElement.className = "teacher-ar-canvas";
    tracker.cssRenderer.domElement.hidden = true;
    this.renderer.setAnimationLoop(null);
    this.controls.enabled = false;
    // The preview has already drawn a model. Clear its last frame as well as
    // hiding its canvas before the camera starts; never carry it into scanning.
    this.model.visible = false;
    this.renderer.clear();
    this.renderer.domElement.hidden = true;
    this.renderer.domElement.style.display = "none";
    this.lights(tracker.scene);
    const anchor = tracker.addAnchor(0);
    anchor.onTargetFound = () => {
      if (this.tracker !== tracker) return;
      this.tracked = true; this.model.visible = true; this.onTracking(true);
    };
    anchor.onTargetLost = () => {
      if (this.tracker !== tracker) return;
      this.tracked = false; this.model.visible = false;
      tracker.renderer.clear(); this.onTracking(false); this.positionHotspots();
    };
    anchor.group.add(this.model); this.reset();
    try {
      await tracker.start();
      if (this.closed || generation !== this.scanGeneration) { tracker.close(); return false; }
      tracker.renderer.setPixelRatio(Math.min(devicePixelRatio, 1.5));
      tracker.renderer.setAnimationLoop(() => this.draw());
      this.resize();
      return true;
    } catch (error) {
      const cancelled = generation !== this.scanGeneration || this.closed;
      if (this.tracker === tracker) this.stopScanning();
      else tracker.close();
      if (cancelled) return false;
      throw error;
    }
  }
  stopScanning() {
    this.scanGeneration++;
    const tracker = this.tracker;
    this.tracker = null; this.tracked = false;
    if (this.model) { this.scene.add(this.model); this.model.rotation.x = 0; this.model.visible = true; }
    tracker?.close();
    this.controls.enabled = true;
    this.renderer.domElement.hidden = false;
    this.renderer.domElement.style.display = "";
    if (!this.closed) this.renderer.setAnimationLoop(() => this.draw());
    this.onTracking(false);
    this.positionHotspots();
  }
  pointer(event) {
    if (!this.model || event.target.closest("button, input, select, a")) return;
    if (event.type === "pointerdown") {
      this.pointers.set(event.pointerId, { x: event.clientX, y: event.clientY, startX: event.clientX, startY: event.clientY });
      if (this.tracker) this.stage.setPointerCapture(event.pointerId);
      return;
    }
    const pointer = this.pointers.get(event.pointerId);
    if (!pointer) return;
    if (event.type === "pointermove") {
      if (this.tracker && this.pointers.size === 1) {
        this.model.rotateY((event.clientX - pointer.x) * .008);
        this.model.rotateX((event.clientY - pointer.y) * .008);
      }
      pointer.x = event.clientX; pointer.y = event.clientY;
      return;
    }
    this.pointers.delete(event.pointerId);
    if (this.stage.hasPointerCapture(event.pointerId)) this.stage.releasePointerCapture(event.pointerId);
    if (event.type !== "pointerup" || Math.hypot(event.clientX - pointer.startX, event.clientY - pointer.startY) > 8) return;
    if (this.tracker && !this.tracked) return;
    const box = this.stage.getBoundingClientRect();
    const ray = new THREE.Raycaster();
    ray.setFromCamera(new THREE.Vector2((event.clientX - box.left) / box.width * 2 - 1, -(event.clientY - box.top) / box.height * 2 + 1), this.tracker?.camera || this.camera);
    const hit = ray.intersectObject(this.model, true)[0];
    if (!hit) return;
    const parents = new Set(); for (let node = hit.object; node; node = node.parent) parents.add(node);
    const hotspot = this.hotspots.find(item => item.parts.some(part => part.node !== this.content && parents.has(part.node)))
      || this.hotspots.filter(item => item.parts.some(part => part.node === this.content)).sort((first, second) => {
        const distance = item => Math.min(...item.parts.map(part => this.model.localToWorld(part.modelPoint.clone()).distanceToSquared(hit.point)));
        return distance(first) - distance(second);
      })[0];
    if (hotspot) this.onSelect(hotspot.label.id);
  }
  draw() {
    if (this.closed || document.visibilityState === "hidden") return;
    if (this.model) this.model.visible = !this.tracker || Boolean(this.tracked);
    const delta = Math.min(this.clock.getDelta(), .1);
    if (!this.paused && (!this.tracker || this.tracked)) this.mixers?.forEach(mixer => mixer.update(delta));
    if (this.tracker) this.tracker.renderer.render(this.tracker.scene, this.tracker.camera);
    else { this.controls.update(); this.renderer.render(this.scene, this.camera); }
    this.positionHotspots();
  }
  screenshot() {
    this.draw();
    const canvas = document.createElement("canvas"), source = this.tracker?.renderer.domElement || this.renderer.domElement;
    canvas.width = source.width; canvas.height = source.height;
    const context = canvas.getContext("2d");
    context.fillStyle = "#e3f1ff"; context.fillRect(0, 0, canvas.width, canvas.height);
    const video = this.tracker?.video;
    if (video?.videoWidth) {
      const ratio = Math.max(canvas.width / video.videoWidth, canvas.height / video.videoHeight);
      context.drawImage(video, (canvas.width - video.videoWidth * ratio) / 2, (canvas.height - video.videoHeight * ratio) / 2, video.videoWidth * ratio, video.videoHeight * ratio);
    }
    context.drawImage(source, 0, 0, canvas.width, canvas.height);
    return new Promise((resolve, reject) => canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error("Screenshot could not be created.")), "image/png"));
  }
  disposeObject(root) {
    const textures = new Set(), materials = new Set(), geometries = new Set();
    root.traverse(node => {
      if (node.geometry) geometries.add(node.geometry);
      for (const material of Array.isArray(node.material) ? node.material : [node.material]) {
        if (!material) continue;
        materials.add(material);
        Object.values(material).forEach(value => { if (value?.isTexture) textures.add(value); });
      }
    });
    geometries.forEach(item => item.dispose()); materials.forEach(item => item.dispose()); textures.forEach(item => item.dispose());
  }
  clearModel() {
    this.restoreHighlight();
    this.mixers?.forEach(mixer => { mixer.stopAllAction(); mixer.uncacheRoot(mixer.getRoot()); });
    this.mixers = [];
    if (this.model) { this.model.removeFromParent(); this.disposeObject(this.model); }
    this.model = null;
    this.hotspots?.forEach(hotspot => hotspot.button.remove()); this.hotspots = [];
  }
  dispose() {
    if (this.closed) return;
    this.closed = true; this.generation++;
    this.modelAbort?.abort();
    this.stopScanning(); this.clearModel();
    this.abort.abort(); this.resizeObserver.disconnect(); this.controls.dispose();
    this.renderer.setAnimationLoop(null); this.renderer.dispose(); this.renderer.domElement.remove();
  }
}
