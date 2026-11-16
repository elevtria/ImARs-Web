// Loaded only when a signed-in teacher opens the AR classroom.
import { THREE, GLTFLoader, MindARThree } from "./vendor/teacher-ar-engine.js";

export function stopCameraTracks(stream) {
  stream?.getTracks().forEach(track => track.stop());
}

export async function tuneTrackingCamera(stream) {
  try {
    const track = stream?.getVideoTracks?.()[0], capabilities = track?.getCapabilities?.();
    const settings = {};
    for (const name of ["focusMode", "exposureMode"]) {
      if (capabilities?.[name]?.includes("continuous")) settings[name] = "continuous";
    }
    if (Object.keys(settings).length) await track.applyConstraints({ advanced: [settings] });
  } catch { /* Optional camera tuning must never prevent scanning. */ }
}

// Own the stream even while permission or startup is pending, so leaving the page
// cannot leave a late camera request running in the background.
export class TeacherMarkerTracker extends MindARThree {
  async _startVideo() {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: {
      width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 },
      ...(this.deviceId ? { deviceId: { exact: this.deviceId } } : { facingMode: "environment" })
    } });
    if (this.closed) { stopCameraTracks(stream); throw new DOMException("Camera closed", "AbortError"); }
    this.stream = stream;
    void tuneTrackingCamera(stream);
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
  constructor({ stage, overlay, onStatus, onTracking, onSelect, onModelDetected, onDissection, onLabelAnchor }) {
    Object.assign(this, { stage, overlay, onStatus, onTracking, onSelect, onModelDetected, onDissection, onLabelAnchor });
    this.scene = new THREE.Scene();
    this.clock = new THREE.Clock();
    this.quality = "medium";
    this.paused = false; this.zoom = 1; this.highlighted = []; this.hotspots = []; this.indicatorsVisible = true;
    this.generation = 0; this.scanGeneration = 0;
    this.pointers = new Map();
    this.abort = new AbortController();
    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(stage);
    for (const name of ["pointerdown", "pointermove", "pointerup", "pointercancel"]) {
      stage.addEventListener(name, event => this.pointer(event), { signal: this.abort.signal });
    }
  }
  lights(scene) {
    scene.add(new THREE.HemisphereLight(0xffffff, 0x7a8ea5, 2.5));
    const light = new THREE.DirectionalLight(0xffffff, 3);
    light.position.set(2, 4, 3); scene.add(light);
  }
  resize() {
    const width = this.stage.clientWidth, height = this.stage.clientHeight;
    if (!width || !height) return;
    this.tracker?.resize();
  }
  async load(item) {
    this.tracked = false; this.onTracking(false);
    this.modelAbort?.abort(); this.modelAbort = new AbortController();
    const signal = this.modelAbort.signal;
    const generation = ++this.generation;
    this.clearModel(); this.item = item; this.paused = false; this.zoom = 1;
    const loader = new GLTFLoader(), results = [];
    const assets = [...item.models, ...(item.dissection ? [item.dissection.model] : [])];
    try {
      // Load models one by one to limit peak memory on classroom phones.
      for (const asset of assets) {
        const response = await fetch(asset.url, { signal });
        if (!response.ok) throw new Error("The model could not be loaded. Please try again.");
        const gltf = await loader.parseAsync(await response.arrayBuffer(), "");
        results.push(gltf);
        if (asset.root) this.isolateModel(gltf, asset.root);
        if (this.closed || generation !== this.generation) { results.forEach(result => this.disposeObject(result.scene)); return false; }
      }
    } catch (error) { results.forEach(result => this.disposeObject(result.scene)); throw error; }
    this.model = new THREE.Group();
    this.content = new THREE.Group(); this.model.add(this.content);
    this.mixers = []; this.modelFrames = [];
    results.forEach((gltf, index) => {
      const box = new THREE.Box3().setFromObject(gltf.scene), size = box.getSize(new THREE.Vector3());
      const scale = 1.35 / Math.max(size.x, size.y, size.z, .001);
      const frame = new THREE.Group();
      frame.scale.setScalar(scale);
      const center = box.getCenter(new THREE.Vector3());
      gltf.scene.position.sub(new THREE.Vector3(center.x, box.min.y, center.z));
      frame.add(gltf.scene);
      if (!item.dissection && results.length > 1) frame.position.set((index % 2 - .5) * 1.6, 0, Math.floor(index / 2) * 1.6 - .8);
      this.content.add(frame);
      this.modelFrames.push({ frame, root: gltf.scene, name: assets[index].name });
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
    if (item.dissection) {
      this.wholeFrame = this.modelFrames[0].frame;
      this.cutawayFrame = this.modelFrames.at(-1).frame;
    }
    this.buildHotspots(item.labels);
    this.reset(); this.model.visible = false;
    if (this.tracker && this.activeAnchor?.modelId === item.id && this.activeAnchor.group.visible) {
      this.activeAnchor.group.add(this.model);
      this.tracked = true; this.model.visible = true; this.onTracking(true);
    }
    this.draw();
    return true;
  }
  isolateModel(gltf, name) {
    let selected;
    gltf.scene.traverse(node => { if (safeName(node.name) === safeName(name)) selected = node; });
    if (!selected) throw new Error("The cutaway model could not be found.");
    // The teaching source includes a comparison scene. Keep the actual interior
    // half only, so opening the model never adds a second complete volcano.
    gltf.scene.attach(selected);
    for (const child of [...gltf.scene.children]) if (child !== selected) { child.removeFromParent(); this.disposeObject(child); }
    gltf.animations = gltf.animations.map(clip => {
      const filtered = clip.clone();
      filtered.tracks = filtered.tracks.filter(track => {
        const node = THREE.PropertyBinding.findNode(gltf.scene, THREE.PropertyBinding.parseTrackName(track.name).nodeName);
        return node && node !== selected; // Keep the interior centred while smoke/lava animate.
      });
      return filtered;
    }).filter(clip => clip.tracks.length);
  }
  findPart(part) {
    const root = this.modelFrames?.find(frame => frame.name === part.model)?.root || this.content;
    const name = safeName(part.path?.split("/").pop());
    if (!name || name === "node_0") return root;
    let found;
    root.traverse(node => { if (!found && safeName(node.name) === name) found = node; });
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
      button.setAttribute("aria-label", `Play narration: ${label.title}`);
      button.title = `Click to hear about ${label.title}`;
      button.hidden = true;
      button.addEventListener("click", event => { event.stopPropagation(); this.onSelect(label.id); });
      this.overlay.append(button);
      return { label, parts, button };
    });
  }
  setLabels(visible) { this.labelsVisible = visible; this.positionHotspots(); }
  setIndicators(visible) { this.indicatorsVisible = visible; this.positionHotspots(); }
  partVisible(node) {
    for (let current = node; current && current !== this.model; current = current.parent) if (!current.visible) return false;
    return true;
  }
  positionHotspots() {
    if (!this.model) { this.onLabelAnchor?.(null); return; }
    const camera = this.tracker?.camera;
    let anchor = null;
    for (const hotspot of this.hotspots) {
      const part = hotspot.parts.find(part => this.partVisible(part.node));
      const visible = this.tracker && this.tracked && Boolean(part);
      hotspot.button.hidden = !visible;
      // Names and descriptions live beside the view. Only light rings sit on it.
      hotspot.button.dataset.labels = "false";
      if (!visible) continue;
      const point = this.model.localToWorld(part.modelPoint.clone());
      point.project(camera);
      const inView = point.z >= -1 && point.z <= 1 && Math.abs(point.x) <= 1 && Math.abs(point.y) <= 1;
      const x = Math.round((point.x + 1) * this.stage.clientWidth / 2), y = Math.round((1 - point.y) * this.stage.clientHeight / 2);
      hotspot.button.hidden = !inView || this.indicatorsVisible === false;
      hotspot.button.style.left = `${x}px`; hotspot.button.style.top = `${y}px`;
      if (inView && hotspot.label.id === this.selectedLabelId) anchor = { x, y };
    }
    this.onLabelAnchor?.(anchor);
  }
  selectLabel(id) {
    this.restoreHighlight();
    this.selectedLabelId = id;
    const hotspot = this.hotspots.find(item => item.label.id === id);
    if (id === null) this.setDissected(false);
    else if (this.item?.dissection && hotspot && (this.item.dissection.kind === "volcano" || hotspot.parts.every(part => !this.partVisible(part.node)))) this.setDissected(true);
    this.hotspots.forEach(item => item.button.setAttribute("aria-pressed", String(item === hotspot)));
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
    this.positionHotspots();
  }
  restoreHighlight() {
    for (const { node, original } of this.highlighted) {
      for (const material of Array.isArray(node.material) ? node.material : [node.material]) material.dispose();
      node.material = original;
    }
    this.highlighted = [];
  }
  setDissected(value) {
    if (!this.cutawayFrame || !this.wholeFrame) return;
    this.dissected = Boolean(value);
    this.wholeFrame.visible = !this.dissected; this.cutawayFrame.visible = this.dissected;
    this.positionHotspots(); this.onDissection?.();
  }
  reset() {
    if (!this.model) return;
    this.model.rotation.set(Math.PI / 2, 0, 0);
    this.zoom = 1; this.model.scale.setScalar(1);
    this.restoreHighlight();
    this.setDissected(false);
  }
  setZoom(value) { this.zoom = Math.max(.5, Math.min(2, Number(value) || 1)); this.model?.scale.setScalar(this.zoom); }
  rotate(direction) { if (this.model) this.model.rotateY(direction * Math.PI / 12); }
  setPaused(value) { this.paused = value; this.clock.getDelta(); }
  setQuality(value) {
    this.quality = value;
    const ratio = Math.min(devicePixelRatio, value === "low" ? 1 : value === "high" ? 2 : 1.5);
    this.tracker?.renderer.setPixelRatio(ratio); this.resize();
  }
  async startScanning(deviceId, scanner) {
    if (this.closed || !scanner?.targetModels?.length) return false;
    this.stopScanning();
    const generation = ++this.scanGeneration;
    const tracker = new TeacherMarkerTracker({ container: this.stage, imageTargetSrc: scanner.target,
      maxTrack: 1, uiLoading: "no", uiScanning: "no", uiError: "no", warmupTolerance: 1, missTolerance: 8 });
    this.tracker = tracker; tracker.deviceId = deviceId;
    tracker.renderer.domElement.className = "teacher-ar-canvas";
    tracker.cssRenderer.domElement.hidden = true;
    if (this.model) this.model.visible = false;
    this.lights(tracker.scene);
    this.activeAnchor = null;
    scanner.targetModels.forEach((modelId, index) => {
      const anchor = tracker.addAnchor(index);
      anchor.modelId = modelId;
      anchor.onTargetFound = () => {
        if (this.tracker !== tracker) return;
        this.activeAnchor = anchor;
        const loaded = Boolean(this.model && this.item?.id === modelId);
        this.tracked = loaded;
        if (loaded) anchor.group.add(this.model);
        if (this.model) this.model.visible = loaded;
        this.onTracking(loaded);
        this.onModelDetected?.(modelId);
      };
      anchor.onTargetLost = () => {
        if (this.tracker !== tracker || this.activeAnchor !== anchor) return;
        this.activeAnchor = null; this.tracked = false;
        if (this.model) this.model.visible = false;
        tracker.renderer.clear(); this.onTracking(false); this.positionHotspots();
      };
    });
    try {
      await tracker.start();
      if (this.closed || generation !== this.scanGeneration) { tracker.close(); return false; }
      this.setQuality(this.quality);
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
    this.tracker = null; this.tracked = false; this.activeAnchor = null;
    if (this.model) { this.scene.add(this.model); this.model.visible = false; }
    tracker?.close();
    this.onTracking(false);
    this.positionHotspots();
  }
  pointer(event) {
    if (!this.model || !this.tracker || !this.tracked || event.target.closest("button, input, select, a")) return;
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
    ray.setFromCamera(new THREE.Vector2((event.clientX - box.left) / box.width * 2 - 1, -(event.clientY - box.top) / box.height * 2 + 1), this.tracker.camera);
    const hit = ray.intersectObject(this.model, true).find(hit => this.partVisible(hit.object));
    if (!hit) return;
    if (this.cutawayFrame) { this.setDissected(!this.dissected); return; }
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
    if (this.model) this.model.visible = Boolean(this.tracker && this.tracked);
    const delta = Math.min(this.clock.getDelta(), .1);
    if (!this.paused && this.tracker && this.tracked) this.mixers?.forEach(mixer => mixer.update(delta));
    if (this.tracker) this.tracker.renderer.render(this.tracker.scene, this.tracker.camera);
    this.positionHotspots();
  }
  screenshot() {
    if (!this.tracker || !this.tracked || !this.model) throw new Error("Scan a marker before taking a screenshot.");
    this.draw();
    const canvas = document.createElement("canvas"), source = this.tracker.renderer.domElement;
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
    this.model = null; this.modelFrames = []; this.wholeFrame = this.cutawayFrame = null; this.dissected = false; this.selectedLabelId = null;
    this.hotspots?.forEach(hotspot => hotspot.button.remove()); this.hotspots = [];
    this.onLabelAnchor?.(null);
  }
  dispose() {
    if (this.closed) return;
    this.closed = true; this.generation++;
    this.modelAbort?.abort();
    this.stopScanning(); this.clearModel();
    this.abort.abort(); this.resizeObserver.disconnect();
  }
}
