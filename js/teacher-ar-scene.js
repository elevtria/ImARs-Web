// Loaded only when a signed-in teacher opens the AR classroom.
import { THREE, GLTFLoader, MindARThree } from "./vendor/teacher-ar-engine.js";
import { enableMotionRecovery } from "./teacher-marker-search.js";

// MindAR processes the negotiated camera size on every tracking pass.
const TRACKING_WIDTH = 960;
const TRACKING_HEIGHT = 540;

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
      width: { ideal: TRACKING_WIDTH }, height: { ideal: TRACKING_HEIGHT }, frameRate: { ideal: 60 },
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
  async _startAR() {
    if (this.closed) throw new DOMException("Camera closed", "AbortError");
    await super._startAR();
    if (this.closed) {
      this.controller.stopProcessVideo();
      throw new DOMException("Camera closed", "AbortError");
    }
    this.expireStalePoses = enableMotionRecovery(this.controller);
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

class MarkerPose {
  constructor() {
    this.position = new THREE.Vector3();
    this.rotation = new THREE.Quaternion();
    this.scale = new THREE.Vector3();
    this.targetPosition = new THREE.Vector3();
    this.targetRotation = new THREE.Quaternion();
    this.targetScale = new THREE.Vector3();
  }

  update(group, elapsed) {
    // MindAR replaces the anchor matrix when it has a new pose. Keep drawing
    // toward that pose between tracker updates, at the display's frame rate.
    const matrix = group.matrix;
    if (matrix !== this.sample || group !== this.group) {
      this.sample = matrix;
      matrix.decompose(this.targetPosition, this.targetRotation, this.targetScale);
      this.targetRotation.normalize();
      if (this.group !== group) {
        this.group = group;
        this.position.copy(this.targetPosition);
        this.rotation.copy(this.targetRotation);
        this.scale.copy(this.targetScale);
      }
    }
    const blend = 1 - Math.exp(-elapsed / .025);
    this.position.lerp(this.targetPosition, blend);
    this.rotation.slerp(this.targetRotation, blend);
    this.scale.lerp(this.targetScale, blend);
    matrix.compose(this.position, this.rotation, this.scale);
    group.matrixWorldNeedsUpdate = true;
  }

  reset() {
    this.group = null;
    this.sample = null;
  }
}

const safeName = name => THREE.PropertyBinding.sanitizeNodeName(name || "").toLowerCase();
export class TeacherARScene {
  constructor({ stage, overlay, onStatus, onTracking, onSelect, onModelDetected, onDissection, onLabelAnchor }) {
    Object.assign(this, { stage, overlay, onStatus, onTracking, onSelect, onModelDetected, onDissection, onLabelAnchor });
    this.scene = new THREE.Scene();
    this.clock = new THREE.Clock();
    this.quality = "medium";
    this.paused = false; this.zoom = 1; this.hotspots = []; this.indicatorsVisible = true;
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
    const tracker = this.tracker;
    if (!width || !height || !tracker) return;
    // Limit the number of rendered pixels in Low and Balanced, including when
    // the stage fills the screen in presentation mode.
    const limit = this.quality === "low" ? 1 : this.quality === "high" ? 2 : 1.5;
    const pixelBudget = this.quality === "low" ? 640 * 480 : 960 * 720;
    const budgetRatio = this.quality === "high" ? limit : Math.sqrt(pixelBudget / (width * height));
    const ratio = Math.min(devicePixelRatio, limit, budgetRatio);
    if (tracker.renderer.getPixelRatio() !== ratio) tracker.renderer.setPixelRatio(ratio);
    tracker.resize();
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
        this.filterModelAnimations(gltf);
        if (asset.root) this.isolateModel(gltf, asset.root);
        if (this.closed || generation !== this.generation) { results.forEach(result => this.disposeObject(result.scene)); return false; }
      }
    } catch (error) { results.forEach(result => this.disposeObject(result.scene)); throw error; }
    this.model = new THREE.Group();
    this.content = new THREE.Group(); this.model.add(this.content);
    this.mixers = []; this.modelFrames = [];
    results.forEach((gltf, index) => {
      const mixer = new THREE.AnimationMixer(gltf.scene);
      gltf.animations.forEach(clip => mixer.clipAction(clip).play());
      mixer.update(0);
      const box = new THREE.Box3().setFromObject(gltf.scene, true), size = box.getSize(new THREE.Vector3());
      const scale = 1.35 / Math.max(size.x, size.y, size.z, .001);
      const frame = new THREE.Group();
      frame.scale.setScalar(scale);
      const center = box.getCenter(new THREE.Vector3());
      gltf.scene.position.sub(new THREE.Vector3(center.x, box.min.y, center.z));
      frame.add(gltf.scene);
      if (!item.dissection && results.length > 1) frame.position.set((index % 2 - .5) * 1.6, 0, Math.floor(index / 2) * 1.6 - .8);
      this.content.add(frame);
      this.modelFrames.push({ frame, root: gltf.scene, name: assets[index].name });
      this.mixers.push(mixer);
    });
    const combined = new THREE.Box3().setFromObject(this.content, true), size = combined.getSize(new THREE.Vector3());
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
    this.filterModelAnimations(gltf, selected);
  }
  filterModelAnimations(gltf, fixedRoot) {
    gltf.animations = gltf.animations.map(clip => {
      const filtered = clip.clone();
      filtered.tracks = filtered.tracks.filter(track => {
        const node = THREE.PropertyBinding.findNode(gltf.scene, THREE.PropertyBinding.parseTrackName(track.name).nodeName);
        return node && node !== fixedRoot; // Keep the interior centred while smoke/lava animate.
      });
      return filtered;
    }).filter(clip => clip.tracks.length);
  }
  findPart(part) {
    const root = this.modelFrames?.find(frame => frame.name === part.model)?.root || this.content;
    const name = safeName(part.path?.split("/").pop());
    if (!name || name === "node_0") return root;
    let found;
    root.traverse(node => { if (!found && (safeName(node.name) === name || safeName(node.userData.name) === name)) found = node; });
    return found;
  }
  buildHotspots(labels) {
    this.model.updateMatrixWorld(true);
    const surfaces = new Map();
    const surface = root => {
      if (surfaces.has(root)) return surfaces.get(root);
      const box = new THREE.Box3(), samples = [], inverse = root.matrixWorld.clone().invert();
      root.traverse(mesh => {
        const count = mesh.geometry?.attributes?.position?.count;
        if (!mesh.isMesh || !count) return;
        const transform = new THREE.Matrix4().multiplyMatrices(inverse, mesh.matrixWorld);
        const points = new Float32Array(count * 3), point = new THREE.Vector3();
        for (let index = 0; index < count; index++) {
          mesh.getVertexPosition(index, point).applyMatrix4(transform);
          point.toArray(points, index * 3); box.expandByPoint(point);
        }
        samples.push({ mesh, points });
      });
      const data = { root, box, samples }; surfaces.set(root, data); return data;
    };
    this.hotspots = labels.map(label => {
      const parts = label.parts.flatMap(part => {
        const node = this.findPart(part);
        if (node === this.content && this.modelFrames?.length) return this.modelFrames.map(frame => ({ node: frame.root, point: part.point }));
        return node ? [{ node, point: part.point }] : [];
      });
      parts.forEach(part => {
        let data = surface(part.node);
        if (!data.samples.length) data = surface(this.modelFrames?.find(frame => frame.root.getObjectById(part.node.id))?.root || this.content);
        const box = data.box;
        const extent = box.getSize(new THREE.Vector3()).multiplyScalar(.5);
        part.localPoint = data.root !== part.node
          ? data.root.worldToLocal(part.node.getWorldPosition(new THREE.Vector3()))
          : box.isEmpty() ? new THREE.Vector3() : box.getCenter(new THREE.Vector3()).add(new THREE.Vector3(part.point.x, part.point.y, part.point.z).multiply(extent));
        let distance = Infinity;
        // A box corner can be empty space. Bind to an actual surface vertex,
        // then follow that vertex through mesh, morph and skeleton animation.
        for (const { mesh, points } of data.samples) for (let index = 0; index < points.length; index += 3) {
          const next = (points[index] - part.localPoint.x) ** 2 + (points[index + 1] - part.localPoint.y) ** 2 + (points[index + 2] - part.localPoint.z) ** 2;
          if (next < distance) { distance = next; part.mesh = mesh; part.vertexIndex = index / 3; }
        }
        part.modelPoint = this.model.worldToLocal(data.root.localToWorld(part.localPoint.clone()));
      });
      const button = document.createElement("button");
      button.type = "button"; button.className = "teacher-ar-hotspot"; button.textContent = label.title;
      button.setAttribute("aria-label", `Play narration: ${label.title}`);
      button.title = `Click to hear about ${label.title}`;
      button.dataset.labels = "false";
      button.hidden = true;
      button.addEventListener("click", event => { event.stopPropagation(); this.onSelect(label.id); });
      this.overlay.append(button);
      return { label, parts, button };
    });
  }
  anchorWorld(part, point = new THREE.Vector3(), matricesCurrent = false) {
    if (part.mesh) part.mesh.getVertexPosition(part.vertexIndex, point);
    else point.copy(part.modelPoint);
    const object = part.mesh || this.model;
    // The renderer already updated these matrices for this frame.
    if (!matricesCurrent) object.updateWorldMatrix(true, false);
    return point.applyMatrix4(object.matrixWorld);
  }
  setLabels(visible) { this.labelsVisible = visible; this.positionHotspots(); }
  setIndicators(visible) { this.indicatorsVisible = visible; this.positionHotspots(); }
  partVisible(node) {
    for (let current = node; current && current !== this.model; current = current.parent) if (!current.visible) return false;
    return true;
  }
  positionHotspots(matricesCurrent = false) {
    if (!this.model) { this.onLabelAnchor?.(null); return; }
    const camera = this.tracker?.camera;
    const tracking = camera && this.tracked;
    const width = tracking ? this.stage.clientWidth : 0;
    const height = tracking ? this.stage.clientHeight : 0;
    const showIndicator = this.indicatorsVisible !== false;
    let anchor = null;
    for (const hotspot of this.hotspots) {
      const isSelected = hotspot.label.id === this.selectedLabelId;
      const part = tracking && (showIndicator || isSelected) && hotspot.parts.find(part => this.partVisible(part.node));
      if (!part) {
        if (!hotspot.button.hidden) hotspot.button.hidden = true;
        continue;
      }
      const point = this.anchorWorld(part, this.projectedPoint ||= new THREE.Vector3(), matricesCurrent);
      point.project(camera);
      const inView = point.z >= -1 && point.z <= 1 && Math.abs(point.x) <= 1 && Math.abs(point.y) <= 1;
      const hidden = !inView || !showIndicator;
      if (hotspot.button.hidden !== hidden) hotspot.button.hidden = hidden;
      if (!inView) continue;
      const x = Math.round((point.x + 1) * width / 2), y = Math.round((1 - point.y) * height / 2);
      if (!hidden) {
        if (hotspot.x !== x) { hotspot.x = x; hotspot.button.style.left = `${x}px`; }
        if (hotspot.y !== y) { hotspot.y = y; hotspot.button.style.top = `${y}px`; }
      }
      if (isSelected) anchor = { x, y };
    }
    this.onLabelAnchor?.(anchor);
  }
  selectLabel(id) {
    this.selectedLabelId = id;
    const hotspot = this.hotspots.find(item => item.label.id === id);
    if (id === null) this.setDissected(false);
    else if (this.item?.dissection && hotspot && (this.item.dissection.kind === "volcano" || hotspot.parts.every(part => !this.partVisible(part.node)))) this.setDissected(true);
    this.hotspots.forEach(item => item.button.setAttribute("aria-pressed", String(item === hotspot)));
    this.positionHotspots();
  }
  setDissected(value, immediate = false) {
    if (!this.cutawayFrame || !this.wholeFrame) return;
    this.dissected = Boolean(value);
    if (immediate) this.revealAmount = this.dissected ? 1 : 0;
    this.advanceDissection(0);
    this.positionHotspots(); this.onDissection?.();
  }
  advanceDissection(delta) {
    if (!this.cutawayFrame || !this.wholeFrame) return;
    const goal = this.dissected ? 1 : 0, amount = this.revealAmount || 0;
    this.revealAmount = goal > amount ? Math.min(goal, amount + delta / .7) : Math.max(goal, amount - delta / .7);
    const t = this.revealAmount, smooth = value => value * value * (3 - 2 * value);
    this.wholeFrame.visible = t < .4; this.cutawayFrame.visible = t >= .4;
    this.wholeFrame.rotation.y = Math.PI / 9 * smooth(Math.min(1, t / .4));
    this.cutawayFrame.rotation.y = -Math.PI / 9 * (1 - smooth(Math.max(0, (t - .4) / .6)));
  }
  reset() {
    if (!this.model) return;
    this.model.rotation.set(Math.PI / 2, 0, 0);
    this.zoom = 1; this.model.scale.setScalar(1);
    this.setDissected(false, true);
  }
  setZoom(value) { this.zoom = Math.max(.5, Math.min(2, Number(value) || 1)); this.model?.scale.setScalar(this.zoom); }
  rotate(direction) { if (this.model) this.model.rotateY(direction * Math.PI / 12); }
  setPaused(value) { this.paused = value; this.clock.getDelta(); }
  setQuality(value) {
    this.quality = value;
    this.resize();
  }
  async startScanning(deviceId, scanner) {
    if (this.closed || !scanner?.targetModels?.length) return false;
    this.stopScanning();
    const generation = ++this.scanGeneration;
    const tracker = new TeacherMarkerTracker({ container: this.stage, imageTargetSrc: scanner.target,
      maxTrack: 1, uiLoading: "no", uiScanning: "no", uiError: "no", warmupTolerance: 0, missTolerance: 8 });
    this.tracker = tracker; tracker.deviceId = deviceId;
    tracker.renderer.domElement.className = "teacher-ar-canvas";
    tracker.cssRenderer.domElement.hidden = true;
    if (this.model) this.model.visible = false;
    this.lights(tracker.scene);
    this.activeAnchor = null;
    this.resize();
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
        this.markerPose?.reset();
        if (this.model) this.model.visible = false;
        tracker.renderer.clear(); this.onTracking(false); this.positionHotspots();
      };
    });
    try {
      await tracker.start();
      if (this.closed || generation !== this.scanGeneration) { tracker.close(); return false; }
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
    this.emptyFrameRendered = false;
    this.markerPose?.reset();
    if (this.model) { this.scene.add(this.model); this.model.visible = false; }
    tracker?.close();
    this.onTracking(false);
    this.positionHotspots();
  }
  pointer(event) {
    if (!this.model || !this.tracker || !this.tracked || event.target.closest("button, input, select, a, .ar-callout-rail")) return;
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
        const distance = item => Math.min(...item.parts.filter(part => this.partVisible(part.node)).map(part => this.anchorWorld(part).distanceToSquared(hit.point)));
        return distance(first) - distance(second);
      })[0];
    if (hotspot) this.onSelect(hotspot.label.id);
  }
  draw() {
    if (this.closed || document.visibilityState === "hidden") return;
    this.tracker?.expireStalePoses?.();
    if (this.model) this.model.visible = Boolean(this.tracker && this.tracked);
    const delta = Math.min(this.clock.getDelta(), .1);
    const marker = this.activeAnchor?.group;
    if (this.tracked && marker?.matrix) {
      this.markerPose ||= new MarkerPose();
      this.markerPose.update(marker, delta);
    }
    if (!this.paused && this.tracker && this.tracked) {
      this.advanceDissection(delta);
      this.mixers?.forEach(mixer => mixer.update(delta));
    }
    // Leave graphics time for marker detection while the camera is searching.
    if (this.tracker && (this.tracked || !this.emptyFrameRendered)) {
      this.tracker.renderer.render(this.tracker.scene, this.tracker.camera);
      this.emptyFrameRendered = !this.tracked;
    }
    this.positionHotspots(true);
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
    this.mixers?.forEach(mixer => { mixer.stopAllAction(); mixer.uncacheRoot(mixer.getRoot()); });
    this.mixers = [];
    if (this.model) { this.model.removeFromParent(); this.disposeObject(this.model); }
    this.model = null; this.modelFrames = []; this.wholeFrame = this.cutawayFrame = null; this.dissected = false; this.revealAmount = 0; this.selectedLabelId = null;
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
