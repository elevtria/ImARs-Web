// Shared pointer-following tilt and highlight for teacher and admin summaries.
const summaryCards = Array.from(document.querySelectorAll(".admin-overview .stats .stat-link, .teacher-dashboard .stats .stat-link"));
const reducedMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)");
const finePointer = window.matchMedia?.("(hover: hover) and (pointer: fine)");
function resetSummaryCard(card) {
  delete card.dataset.tiltActive;
  for (const name of ["--summary-rotate-x", "--summary-rotate-y", "--summary-glow-x", "--summary-glow-y"]) card.style.removeProperty(name);
}
const summaryResets = [];
summaryCards.forEach(card => {
  let bounds, latest, frame = null;
  const reset = () => {
    if (frame !== null) cancelAnimationFrame(frame);
    frame = null; bounds = latest = null;
    resetSummaryCard(card);
  };
  summaryResets.push(reset);
  card.addEventListener("pointermove", event => {
    if (event.pointerType === "touch" || reducedMotion?.matches || (finePointer && !finePointer.matches)) return;
    bounds ??= card.getBoundingClientRect();
    if (!bounds.width || !bounds.height) return;
    latest = { x: event.clientX, y: event.clientY };
    if (frame !== null) return;
    frame = requestAnimationFrame(() => {
      frame = null;
      const x = Math.max(0, Math.min(1, (latest.x - bounds.left) / bounds.width));
      const y = Math.max(0, Math.min(1, (latest.y - bounds.top) / bounds.height));
      card.style.setProperty("--summary-rotate-x", `${(0.5 - y) * 8}deg`);
      card.style.setProperty("--summary-rotate-y", `${(x - 0.5) * 8}deg`);
      card.dataset.tiltActive = "true";
    });
  });
  card.addEventListener("pointerleave", reset);
  card.addEventListener("pointercancel", reset);
});
const resetSummaries = () => summaryResets.forEach(reset => reset());
reducedMotion?.addEventListener("change", resetSummaries);
finePointer?.addEventListener?.("change", resetSummaries);
window.addEventListener("resize", resetSummaries);
window.addEventListener("scroll", resetSummaries, { passive: true, capture: true });
window.addEventListener("pagehide", resetSummaries);
