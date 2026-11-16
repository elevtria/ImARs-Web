import { initializeApp, getAuth, onAuthStateChanged } from "./firebase-auth.js";
import { teacherARCatalog } from "./teacher-ar-catalog.js";

const auth = getAuth(initializeApp());
const element = id => document.getElementById(id);
const topicSelect = element("arTopic"), modelSelect = element("arModel"), status = element("arStatus");
const audio = element("arAudio");
let scene, owner, selected, selectedLabel, ready = false, busy = false, muted = false, labelsVisible = false;
let modelJob = 0, cameraJob = 0, cameraDevices = [], currentDevice = "", torch = false, enginePromise;

const say = message => { status.textContent = message; };
function buttons() {
  topicSelect.disabled = modelSelect.disabled = !owner || busy;
  for (const id of ["arScan", "arPreview", "arRotateLeft", "arRotateRight", "arZoom", "arReset", "arLabels", "arScreenshot", "arFullModel", "arPresentation"]) element(id).disabled = !ready || busy;
  element("arPause").disabled = !ready || !scene?.animated || busy;
  element("arRefresh").disabled = !scene?.tracker || busy;
  element("arNarration").disabled = muted || !selectedLabel?.audio;
  element("arPause").textContent = scene?.animated ? (scene.paused ? "Resume animation" : "Pause animation") : "Static model";
  element("arPause").setAttribute("aria-pressed", String(Boolean(scene?.paused)));
}
function stopNarration() { audio.pause(); audio.removeAttribute("src"); audio.load(); }
function clearSelection() {
  stopNarration(); selectedLabel = null;
  element("arDescription").hidden = true; scene?.selectLabel(null);
  element("arParts").querySelectorAll("button").forEach(button => button.setAttribute("aria-pressed", "false"));
  buttons();
}
function selectLabel(id) {
  const label = selected?.labels.find(item => item.id === id);
  if (!label || !ready) return;
  stopNarration(); selectedLabel = label;
  element("arDescriptionTitle").textContent = label.title;
  element("arDescriptionText").textContent = label.description;
  element("arDescription").hidden = false;
  element("arParts").querySelectorAll("button").forEach(button => button.setAttribute("aria-pressed", String(button.dataset.label === id)));
  scene.selectLabel(id); buttons();
}
function tracking(found) {
  const label = element("arTracking");
  label.hidden = !scene?.tracker;
  label.textContent = found ? "Marker found" : "Looking for marker";
  label.dataset.found = String(found);
  if (scene?.tracker && !busy) say(found ? "Marker found. Drag the model to rotate, or select a part to explore it." : "Keep the whole selected marker in view and hold the camera steady.");
}
function setPresentation(value) {
  if (!scene && value) return;
  element("arStageCard").classList.toggle("is-presenting", value);
  document.body.classList.toggle("ar-presenting", value);
  element("arPresentation").setAttribute("aria-pressed", String(value));
  element("arPresentation").textContent = value ? "Show controls" : "Presentation mode";
  if (scene) { scene.presenting = value; scene.resize(); }
  if (value) audio.pause();
}
function stopCamera(message = "Camera stopped. You can continue using the model preview.") {
  cameraJob++; busy = false;
  scene?.stopScanning(); torch = false;
  element("arMode").textContent = "Model preview";
  element("arExitCamera").hidden = true;
  element("arSwitchCamera").hidden = element("arTorch").hidden = true;
  element("arTorch").setAttribute("aria-pressed", "false");
  element("arHint").textContent = "Drag to rotate. Scroll or pinch to zoom. Select a part or description to teach it.";
  buttons(); if (message) say(message);
}
async function loadModel() {
  const item = teacherARCatalog.find(model => model.id === modelSelect.value);
  if (!owner || !item) return;
  const job = ++modelJob, account = owner;
  stopCamera(""); clearSelection(); ready = false; busy = true; selected = item; buttons();
  element("arRetry").hidden = true; element("arPlaceholder").hidden = false;
  element("arTitle").textContent = item.title; element("arTopicName").textContent = item.topic;
  element("arMarkerImage").src = item.marker;
  element("arMarkerImage").alt = `${item.title} marker — same image used in the ImARs app`;
  element("arMarkerDownload").href = item.marker;
  element("arMarkerDownload").download = `ImARs-${item.title.replace(/[^a-z0-9]+/gi, "-")}-marker.png`;
  const parts = element("arParts"); parts.replaceChildren();
  item.labels.forEach(label => {
    const button = document.createElement("button");
    button.type = "button"; button.textContent = label.title; button.dataset.label = label.id;
    button.setAttribute("aria-pressed", "false"); button.title = label.description;
    button.addEventListener("click", () => selectLabel(label.id)); parts.append(button);
  });
  say(`Loading ${item.title}…`);
  try {
    enginePromise ||= import("./teacher-ar-scene.js").catch(error => { enginePromise = null; throw error; });
    const { TeacherARScene } = await enginePromise;
    if (job !== modelJob || owner !== account) return;
    scene ||= new TeacherARScene({ stage: element("arStage"), overlay: element("arHotspots"), onStatus: say, onTracking: tracking, onSelect: selectLabel });
    const loaded = await scene.load(item);
    if (!loaded || job !== modelJob || owner !== account) return;
    ready = true; scene.setLabels(labelsVisible); scene.setQuality(element("arQuality").value);
    element("arZoom").value = "1"; element("arPlaceholder").hidden = true;
    say(`${item.title} is ready. Explore the model here, or choose Scan marker to use your camera.`);
  } catch (error) {
    if (job !== modelJob || owner !== account || error.name === "AbortError") return;
    console.warn("AR model could not load:", error);
    say("The model could not load. Check your connection and try again. This device also needs WebGL support.");
    element("arRetry").hidden = false;
  } finally { if (job === modelJob && owner === account) { busy = false; buttons(); } }
}
function chooseTopic() {
  modelSelect.replaceChildren();
  for (const item of teacherARCatalog.filter(model => model.topic === topicSelect.value)) {
    modelSelect.add(new Option(item.title, item.id));
  }
  void loadModel();
}
async function startCamera(deviceId = currentDevice) {
  if (!owner || !ready || busy || !scene) return;
  if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
    say("Camera scanning needs a supported browser and a secure connection. Model preview is still available."); return;
  }
  const job = ++cameraJob, account = owner;
  busy = true; buttons(); audio.pause();
  element("arMode").textContent = "Starting camera";
  element("arExitCamera").hidden = false;
  say("Allow camera access, then point at the selected model’s marker.");
  try {
    const started = await scene.startScanning(deviceId || undefined);
    if (!started || job !== cameraJob || account !== owner) return;
    element("arMode").textContent = "Marker AR";
    element("arHint").textContent = "Keep the selected marker in view. Drag to rotate; use Zoom to change the model size.";
    const stream = scene.tracker.stream;
    const track = stream.getVideoTracks()[0];
    currentDevice = track.getSettings?.().deviceId || deviceId || "";
    cameraDevices = (await navigator.mediaDevices.enumerateDevices()).filter(device => device.kind === "videoinput");
    if (job !== cameraJob || account !== owner) return;
    element("arSwitchCamera").hidden = cameraDevices.length < 2;
    element("arTorch").hidden = !track.getCapabilities?.().torch;
    say("Camera ready. Keep the whole selected marker in view and hold it steady.");
  } catch (error) {
    if (job !== cameraJob || owner !== account) return;
    stopCamera("");
    say(error?.name === "NotAllowedError" ? "Camera permission was not granted. You can allow it in your browser and try again, or use Model preview."
      : error?.name === "NotFoundError" ? "No camera was found. Use Model preview or connect a camera and try again."
      : "Camera scanning could not start. Close other apps using the camera and try again. Model preview is still available.");
  } finally { if (job === cameraJob && owner === account) { busy = false; buttons(); tracking(Boolean(scene?.tracked)); } }
}

topicSelect.addEventListener("change", chooseTopic);
modelSelect.addEventListener("change", () => void loadModel());
element("arRetry").addEventListener("click", () => void loadModel());
element("arScan").addEventListener("click", () => void startCamera());
element("arPreview").addEventListener("click", () => stopCamera());
element("arExitCamera").addEventListener("click", () => stopCamera());
element("arRefresh").addEventListener("click", () => { stopCamera(""); scene?.reset(); void startCamera(); });
element("arSwitchCamera").addEventListener("click", () => {
  const index = cameraDevices.findIndex(device => device.deviceId === currentDevice);
  const next = cameraDevices[(index + 1) % cameraDevices.length]?.deviceId;
  if (next) { stopCamera(""); void startCamera(next); }
});
element("arTorch").addEventListener("click", async () => {
  const track = scene?.tracker?.stream?.getVideoTracks()[0];
  if (!track) return;
  try { await track.applyConstraints({ advanced: [{ torch: !torch }] }); torch = !torch; element("arTorch").setAttribute("aria-pressed", String(torch)); }
  catch { say("This camera does not support changing the flashlight."); }
});
element("arRotateLeft").addEventListener("click", () => scene?.rotate(-1));
element("arRotateRight").addEventListener("click", () => scene?.rotate(1));
element("arZoom").addEventListener("input", event => scene?.setZoom(event.target.value));
element("arReset").addEventListener("click", () => { scene?.reset(); element("arZoom").value = "1"; clearSelection(); });
element("arFullModel").addEventListener("click", clearSelection);
element("arLabels").addEventListener("click", () => {
  labelsVisible = !labelsVisible; scene?.setLabels(labelsVisible);
  element("arLabels").textContent = labelsVisible ? "Hide labels" : "Show labels";
  element("arLabels").setAttribute("aria-pressed", String(labelsVisible));
});
element("arPause").addEventListener("click", () => { scene?.setPaused(!scene.paused); buttons(); });
element("arPresentation").addEventListener("click", () => setPresentation(!scene?.presenting));
element("arQuality").addEventListener("change", event => scene?.setQuality(event.target.value));
element("arNarration").addEventListener("click", async () => {
  if (!selectedLabel?.audio || muted) return;
  if (!audio.paused) { audio.pause(); return; }
  if (audio.getAttribute("src") !== selectedLabel.audio) audio.src = selectedLabel.audio;
  try { await audio.play(); } catch { say("Narration could not play. Select the description and try again."); }
});
for (const event of ["play", "pause", "ended"]) audio.addEventListener(event, () => { element("arNarration").textContent = audio.paused || audio.ended ? "Play narration" : "Pause narration"; });
element("arMute").addEventListener("click", () => {
  muted = !muted; audio.muted = muted; if (muted) audio.pause();
  element("arMute").textContent = muted ? "Unmute narration" : "Mute narration";
  element("arMute").setAttribute("aria-pressed", String(muted)); buttons();
});
element("arScreenshot").addEventListener("click", async () => {
  if (!ready || !scene) return;
  try {
    const url = URL.createObjectURL(await scene.screenshot()), link = document.createElement("a");
    link.href = url; link.download = `ImARs-${selected.title.replace(/[^a-z0-9]+/gi, "-")}.png`;
    document.body.append(link); link.click(); link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000); say("Classroom screenshot downloaded.");
  } catch { say("The screenshot could not be saved. Please try again."); }
});
document.addEventListener("keydown", event => {
  if (event.key !== "Escape") return;
  if (scene?.presenting) setPresentation(false);
  else if (scene?.tracker) stopCamera();
});
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") { audio.pause(); if (scene?.tracker) stopCamera("Camera stopped while the page was hidden. Choose Scan marker to resume."); }
});
function leave() {
  owner = null; modelJob++; cameraJob++; ready = false; busy = false;
  setPresentation(false); stopNarration(); scene?.dispose(); scene = null; buttons();
}
window.addEventListener("pagehide", leave);
onAuthStateChanged(auth, user => {
  if (!user || user.role !== "teacher") { leave(); return; }
  if (owner === user.uid) return;
  leave(); owner = user.uid;
  topicSelect.replaceChildren();
  [...new Set(teacherARCatalog.map(model => model.topic))].forEach(topic => topicSelect.add(new Option(topic, topic)));
  const requested = teacherARCatalog.find(model => model.id === new URLSearchParams(window.location.search).get("model"));
  if (requested) topicSelect.value = requested.topic;
  modelSelect.replaceChildren();
  teacherARCatalog.filter(model => model.topic === topicSelect.value).forEach(model => modelSelect.add(new Option(model.title, model.id)));
  if (requested) modelSelect.value = requested.id;
  buttons(); void loadModel();
});
