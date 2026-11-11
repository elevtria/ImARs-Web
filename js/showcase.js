const models = [...document.querySelectorAll(".showcase-model")];
// Decorative login display: no camera controls, links or focusable model UI.
const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
let current = 0, timer;
const ready = new Set(), failed = new Set();

function schedule() {
  clearTimeout(timer);
  if (!reducedMotion.matches && document.visibilityState !== "hidden" && ready.has(current)) {
    timer = setTimeout(() => {
      for (let offset = 1; offset < models.length; offset++) {
        const next = (current + offset) % models.length;
        if (ready.has(next)) { select(next); return; }
      }
      schedule();
    }, 3000);
  }
}
function select(index) {
  if (!models[index]) return;
  current = index;
  models.forEach((model, i) => {
    const active = i === index;
    model.classList.toggle("is-current", active);
    model.toggleAttribute("auto-rotate", active && !reducedMotion.matches && document.visibilityState !== "hidden");
  });
  schedule();
}
models.forEach((model, index) => {
  model.addEventListener("load", () => {
    ready.add(index);
    if (failed.has(current)) select(index);
    else if (current === index) schedule();
  });
  model.addEventListener("error", () => {
    failed.add(index); ready.delete(index);
    if (current === index) select([...ready][0] ?? index);
  });
  if (model.loaded) ready.add(index);
});
document.addEventListener("visibilitychange", () => select(current));
window.addEventListener("pagehide", () => clearTimeout(timer));
window.addEventListener("pageshow", schedule);
reducedMotion.addEventListener("change", () => select(current));
select(current);
