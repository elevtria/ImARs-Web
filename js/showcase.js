const models = [...document.querySelectorAll(".showcase-model")];
const selectors = [...document.querySelectorAll("[data-model-index]")];
const playback = document.getElementById("showcasePlayback");
const status = document.getElementById("modelStatus");
const titles = ["A closer look at the heart.", "A world of discovery.", "Discover what lies beneath."];
const categories = ["THE CIRCULATORY SYSTEM", "MOTION OF THE EARTH", "VOLCANIC ACTIVITY"];
const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
let current = 0, paused = reducedMotion.matches, timer;
const ready = new Set(), failed = new Set();

function schedule() {
  clearTimeout(timer);
  if (!paused && document.visibilityState !== "hidden" && ready.has(current)) {
    timer = setTimeout(() => {
      for (let offset = 1; offset < models.length; offset++) {
        const next = (current + offset) % models.length;
        if (ready.has(next)) { select(next); return; }
      }
      schedule();
    }, 3000);
  }
}
function setPaused(value) {
  paused = value;
  playback.setAttribute("aria-pressed", String(paused));
  playback.setAttribute("aria-label", paused ? "Resume automatic model changes" : "Pause automatic model changes");
  models.forEach(model => model.toggleAttribute("auto-rotate", !paused));
  schedule();
}
function select(index) {
  if (!models[index]) return;
  current = index;
  models.forEach((model, i) => {
    const active = i === index;
    model.classList.toggle("is-current", active);
    model.setAttribute("aria-hidden", String(!active));
    model.inert = !active;
  });
  selectors.forEach((button, i) => button.setAttribute("aria-pressed", String(i === index)));
  document.getElementById("modelTitle").textContent = titles[index];
  document.getElementById("modelCategory").textContent = categories[index];
  status.hidden = ready.has(index);
  status.textContent = failed.has(index) ? "The 3D model could not load. Choose another model or refresh to retry." : "Preparing your 3D experience…";
  schedule();
}
models.forEach((model, index) => {
  model.addEventListener("load", () => {
    ready.add(index);
    if (failed.has(current)) select(index);
    else if (current === index) { status.hidden = true; schedule(); }
  });
  model.addEventListener("error", () => {
    failed.add(index); ready.delete(index);
    if (current === index) select([...ready][0] ?? index);
  });
  // Do not replace a model while someone is inspecting it.
  model.addEventListener("pointerdown", () => setPaused(true));
  model.addEventListener("keydown", event => { if (event.key.startsWith("Arrow")) setPaused(true); });
  if (model.loaded) ready.add(index);
});
selectors.forEach((button, index) => button.addEventListener("click", () => select(index)));
playback.addEventListener("click", () => setPaused(!paused));
document.getElementById("inspectModel").addEventListener("click", () => {
  setPaused(true);
  models[current].focus();
});
document.addEventListener("visibilitychange", schedule);
window.addEventListener("pagehide", () => clearTimeout(timer));
window.addEventListener("pageshow", schedule);
reducedMotion.addEventListener("change", event => setPaused(event.matches));
setPaused(paused);
