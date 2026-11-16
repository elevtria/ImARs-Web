import { initializeApp, getAuth, onAuthStateChanged } from "./firebase-auth.js";
import { teacherARCatalog, teacherARScanner } from "./teacher-ar-catalog.js";
import { TeacherARNarration } from "./teacher-ar-narration.js";
import { TeacherARCallout } from "./teacher-ar-callout.js";

const auth = getAuth(initializeApp());
const element = id => document.getElementById(id);
const status = element("arStatus"), audio = element("arAudio");
let scene, owner, selected, selectedLabel, ready = false, loadingModel = false, startingCamera = false;
let muted = false, labelsVisible = false, modelJob = 0, cameraJob = 0, currentDevice = "", enginePromise;
let indicatorsVisible = true;
const callout = new TeacherARCallout({ frame: element("arStage"), viewport: element("arViewport"), rail: element("arCalloutRail"),
  card: element("arDescription"), svg: element("arDescriptionArrow"), path: element("arDescriptionLine") });
const say = message => { status.textContent = message; };
const narration = new TeacherARNarration(audio, {
  onSubtitle: text => { const subtitle = element("arSubtitles"); if (subtitle.textContent !== text) subtitle.textContent = text; subtitle.hidden = !text; },
  onState: playing => { element("arNarration").textContent = playing ? "Pause narration" : narration.label ? "Resume narration" : "Play narration"; },
  onError: () => say("Narration could not play. Select the label again to retry.")
});
function buttons() {
  const scanning = Boolean(scene?.tracker), modelReady = ready && !loadingModel;
  element("arScan").disabled = !owner || startingCamera || scanning;
  element("arScan").textContent = startingCamera ? "Starting camera…" : scanning ? "Scanning markers" : "Scan markers";
  for (const id of ["arRotateLeft", "arRotateRight", "arZoom", "arReset", "arLabels", "arIndicators", "arScreenshot", "arFullModel"]) element(id).disabled = !modelReady;
  element("arParts").querySelectorAll("button").forEach(button => { button.disabled = !modelReady; });
  element("arPause").disabled = !modelReady || !scene?.animated;
  element("arPause").textContent = selected && !scene?.animated ? "Static model" : scene?.paused ? "Resume animation" : "Pause animation";
  element("arPause").setAttribute("aria-pressed", String(Boolean(scene?.paused)));
  element("arPresentation").disabled = !scanning || startingCamera;
  element("arRefresh").disabled = !scanning || startingCamera;
  element("arNarration").disabled = !modelReady || muted || !(selectedLabel?.audio || selectedLabel?.interactiveAudio);
  element("arDissect").hidden = !selected?.dissection;
  element("arDissect").disabled = !modelReady;
  element("arDissect").textContent = scene?.dissected ? "Show whole model" : "Show inside";
  element("arDissect").setAttribute("aria-pressed", String(Boolean(scene?.dissected)));
  const panelVisible = Boolean(modelReady && (labelsVisible || selectedLabel));
  const rail = element("arCalloutRail");
  if (rail.hidden === panelVisible) { rail.hidden = !panelVisible; callout.refresh(); }
  element("arStage").classList.toggle("has-details", panelVisible);
  element("arParts").hidden = !labelsVisible;
  callout.setEnabled(Boolean(modelReady && selectedLabel));
}
function placeholder(title, text) {
  element("arPlaceholderTitle").textContent = title; element("arPlaceholderText").textContent = text; element("arPlaceholder").hidden = false;
}
function clearSelection() {
  narration.stop(); selectedLabel = null; element("arDescription").hidden = true; scene?.selectLabel(null);
  element("arParts").querySelectorAll("button").forEach(button => button.setAttribute("aria-pressed", "false")); buttons();
}
function selectLabel(id) {
  const label = selected?.labels.find(item => item.id === id);
  if (!label || !ready || !scene?.tracked) return;
  narration.stop(); selectedLabel = label;
  element("arDescriptionTitle").textContent = label.title; element("arDescriptionText").textContent = label.description; element("arDescription").hidden = false;
  element("arParts").querySelectorAll("button").forEach(button => button.setAttribute("aria-pressed", String(button.dataset.label === id)));
  callout.refresh();
  scene.selectLabel(id); buttons(); void narration.start(label);
}
function tracking(found) {
  const label = element("arTracking"); label.hidden = !scene?.tracker;
  label.textContent = found ? "Marker found" : "Looking for a lesson marker"; label.dataset.found = String(found);
  ready = Boolean(found && scene?.model); if (!found) narration.stop(); buttons();
  if (scene?.tracker && !startingCamera && !loadingModel) say(found ? `${selected?.title || "Model"} marker recognized. Select a label to hear its narration.` : "Show any lesson marker to the camera. The matching model will appear automatically.");
}
function setPresentation(value) {
  if (!scene && value) return;
  element("arStageCard").classList.toggle("is-presenting", value); document.body.classList.toggle("ar-presenting", value);
  element("arPresentation").setAttribute("aria-pressed", String(value)); element("arPresentation").textContent = value ? "Show controls" : "Presentation mode";
  callout.refresh(); if (scene) { scene.presenting = value; scene.resize(); }
}
function resetLesson() {
  selected = null; element("arTitle").textContent = "Scan a lesson marker";
  element("arTopicName").textContent = "Its model, labels and narration will appear automatically.";
  element("arMarkerDetails").hidden = true; element("arParts").replaceChildren();
}
function stopCamera(message = "Camera stopped. Choose Scan markers when you’re ready.") {
  cameraJob++; modelJob++; startingCamera = loadingModel = ready = false; narration.stop(); selectedLabel = null;
  scene?.modelAbort?.abort(); if (scene) { scene.generation++; scene.stopScanning(); scene.clearModel(); }
  setPresentation(false); resetLesson(); element("arDescription").hidden = true;
  element("arMode").textContent = "Camera off"; element("arExitCamera").hidden = true; element("arRetry").hidden = true;
  placeholder("Scan a lesson marker", "Start the camera, then show any of your printed ImARs markers."); buttons(); if (message) say(message);
}
function engine() { return enginePromise ||= import("./teacher-ar-scene.js").catch(error => { enginePromise = null; throw error; }); }
async function ensureScene(account) {
  const { TeacherARScene } = await engine(); if (!owner || owner !== account) return null;
  scene ||= new TeacherARScene({ stage: element("arViewport"), overlay: element("arHotspots"), onStatus: say, onTracking: tracking,
    onSelect: selectLabel, onModelDetected: id => { void recognizeModel(id); }, onDissection: buttons, onLabelAnchor: anchor => callout.update(anchor) });
  return scene;
}
async function recognizeModel(id) {
  const item = teacherARCatalog.find(model => model.id === id);
  if (!item || !owner || !scene?.tracker) return;
  if (selected?.id === id && loadingModel) return;
  if (selected?.id === id && scene.model) { tracking(scene.tracked); return; }
  const job = ++modelJob, account = owner, tracker = scene.tracker;
  narration.stop(); selectedLabel = null; selected = item; ready = false; loadingModel = true;
  element("arRetry").hidden = true; element("arDescription").hidden = true;
  element("arTitle").textContent = item.title; element("arTopicName").textContent = item.topic; element("arMarkerDetails").hidden = false;
  element("arHint").textContent = item.dissection ? "Click the model to open or close its cutaway. Click a pulsing spot to hear its narration." : "Click a pulsing spot to hear its narration. Drag to rotate; Show labels displays each part’s name.";
  element("arMarkerImage").src = item.marker; element("arMarkerImage").alt = `${item.title} marker`;
  element("arMarkerDownload").href = item.marker; element("arMarkerDownload").download = `ImARs-${item.title.replace(/[^a-z0-9]+/gi, "-")}-marker.png`;
  const parts = element("arParts"); parts.replaceChildren();
  item.labels.forEach(label => {
    const button = document.createElement("button"); button.type = "button"; button.textContent = label.title; button.dataset.label = label.id;
    button.setAttribute("aria-pressed", "false"); button.title = label.description; button.addEventListener("click", () => selectLabel(label.id)); parts.append(button);
  });
  placeholder(`${item.title} marker found`, "Loading its 3D model…"); say(`${item.title} marker recognized. Loading its model…`); buttons();
  let failed = false;
  try {
    const loaded = await scene.load(item); if (!loaded || job !== modelJob || owner !== account || scene?.tracker !== tracker) return;
    scene.setLabels(labelsVisible); scene.setIndicators(indicatorsVisible); scene.setQuality(element("arQuality").value); element("arZoom").value = "1"; element("arPlaceholder").hidden = true;
  } catch (error) {
    if (job !== modelJob || owner !== account || error.name === "AbortError") return;
    failed = true; say("The marker was recognized, but its model could not load. Check your connection and show the marker again.");
    placeholder("Model could not load", "Show another marker, or try loading this one again."); element("arRetry").hidden = false;
  } finally {
    if (job === modelJob && owner === account) { loadingModel = false; if (!failed) tracking(Boolean(scene?.tracked)); else buttons(); }
  }
}
async function startCamera() {
  if (!owner || startingCamera || scene?.tracker) return;
  if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) { say("Camera scanning needs a supported browser and a secure connection."); return; }
  const job = ++cameraJob, account = owner; startingCamera = true; buttons(); narration.stop();
  element("arMode").textContent = "Starting camera"; element("arExitCamera").hidden = false;
  placeholder("Starting the camera", "Allow camera access, then show any supported lesson marker."); say("Starting the camera and preparing automatic marker recognition…");
  try {
    const currentScene = await ensureScene(account); if (!currentScene || job !== cameraJob) return;
    currentScene.setQuality(element("arQuality").value);
    const started = await currentScene.startScanning(currentDevice || undefined, teacherARScanner); if (!started || job !== cameraJob || account !== owner) return;
    element("arMode").textContent = "Automatic marker AR"; if (!loadingModel) element("arPlaceholder").hidden = true;
    currentDevice = currentScene.tracker.stream.getVideoTracks()[0].getSettings?.().deviceId || "";
  } catch (error) {
    if (job !== cameraJob || owner !== account) return;
    stopCamera(""); if (["NotFoundError", "OverconstrainedError"].includes(error?.name)) currentDevice = "";
    say(error?.name === "NotAllowedError" ? "Camera permission was not granted. Allow it in your browser and choose Scan markers again."
      : error?.name === "NotFoundError" ? "No camera was found. Connect a camera and try again." : "Camera scanning could not start. Close other apps using the camera and try again.");
  } finally { if (job === cameraJob && owner === account) { startingCamera = false; tracking(Boolean(scene?.tracked)); } }
}
element("arScan").addEventListener("click", () => void startCamera());
element("arExitCamera").addEventListener("click", () => stopCamera());
element("arRefresh").addEventListener("click", () => { stopCamera(""); void startCamera(); });
element("arRetry").addEventListener("click", () => { if (selected) void recognizeModel(selected.id); });
element("arScan").addEventListener("pointerenter", () => { if (owner) void engine().catch(() => {}); });
element("arRotateLeft").addEventListener("click", () => scene?.rotate(-1));
element("arRotateRight").addEventListener("click", () => scene?.rotate(1));
element("arZoom").addEventListener("input", event => scene?.setZoom(event.target.value));
element("arReset").addEventListener("click", () => { scene?.reset(); element("arZoom").value = "1"; clearSelection(); });
element("arFullModel").addEventListener("click", clearSelection);
element("arDissect").addEventListener("click", () => { if (ready && scene) scene.setDissected(!scene.dissected); });
element("arLabels").addEventListener("click", () => { labelsVisible = !labelsVisible; scene?.setLabels(labelsVisible); element("arLabels").textContent = labelsVisible ? "Hide labels" : "Show labels"; element("arLabels").setAttribute("aria-pressed", String(labelsVisible)); buttons(); callout.refresh(); });
element("arIndicators").addEventListener("click", () => { indicatorsVisible = !indicatorsVisible; scene?.setIndicators(indicatorsVisible); element("arIndicators").textContent = indicatorsVisible ? "Hide indicators" : "Show indicators"; element("arIndicators").setAttribute("aria-pressed", String(indicatorsVisible)); });
element("arPause").addEventListener("click", () => { scene?.setPaused(!scene.paused); buttons(); });
element("arPresentation").addEventListener("click", () => setPresentation(!scene?.presenting));
element("arQuality").addEventListener("change", event => scene?.setQuality(event.target.value));
element("arNarration").addEventListener("click", () => void narration.toggle(selectedLabel));
element("arMute").addEventListener("click", () => { muted = !muted; narration.setMuted(muted); element("arMute").textContent = muted ? "Unmute narration" : "Mute narration"; element("arMute").setAttribute("aria-pressed", String(muted)); buttons(); });
element("arScreenshot").addEventListener("click", async () => {
  if (!ready || !scene) return;
  try {
    const url = URL.createObjectURL(await scene.screenshot()), link = document.createElement("a"); link.href = url; link.download = `ImARs-${selected.title.replace(/[^a-z0-9]+/gi, "-")}.png`;
    document.body.append(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 60000); say("Classroom screenshot downloaded.");
  } catch { say("The screenshot could not be saved. Please try again."); }
});
document.addEventListener("keydown", event => { if (event.key === "Escape") { if (scene?.presenting) setPresentation(false); else if (scene?.tracker) stopCamera(); } });
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "hidden" && (startingCamera || scene?.tracker)) stopCamera("Camera stopped while the page was hidden. Choose Scan markers to resume."); });
function leave() { owner = null; stopCamera(""); scene?.dispose(); scene = null; }
window.addEventListener("pagehide", leave);
onAuthStateChanged(auth, user => {
  if (!user || user.role !== "teacher") { leave(); return; }
  if (owner === user.uid) return;
  leave(); owner = user.uid; buttons(); say("Choose Scan markers, then show any lesson marker. Models and narration will appear automatically.");
});
