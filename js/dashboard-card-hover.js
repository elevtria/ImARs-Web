// Shared pointer-following tilt and highlight for teacher and admin summaries.
const summaryCards = Array.from(document.querySelectorAll(".admin-overview .stats .stat-link, .teacher-dashboard .stats .stat-link"));
const reducedMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)");
const finePointer = window.matchMedia?.("(hover: hover) and (pointer: fine)");
function resetSummaryCard(card) {
  delete card.dataset.tiltActive;
  for (const name of ["--summary-rotate-x", "--summary-rotate-y", "--summary-glow-x", "--summary-glow-y"]) card.style.removeProperty(name);
}
summaryCards.forEach(card => {
  card.addEventListener("pointermove", event => {
    if (event.pointerType === "touch" || reducedMotion?.matches || (finePointer && !finePointer.matches)) return;
    const bounds = card.getBoundingClientRect();
    if (!bounds.width || !bounds.height) return;
    const x = Math.max(0, Math.min(1, (event.clientX - bounds.left) / bounds.width));
    const y = Math.max(0, Math.min(1, (event.clientY - bounds.top) / bounds.height));
    card.style.setProperty("--summary-rotate-x", `${(0.5 - y) * 8}deg`);
    card.style.setProperty("--summary-rotate-y", `${(x - 0.5) * 8}deg`);
    card.style.setProperty("--summary-glow-x", `${x * 100}%`);
    card.style.setProperty("--summary-glow-y", `${y * 100}%`);
    card.dataset.tiltActive = "true";
  });
  card.addEventListener("pointerleave", () => resetSummaryCard(card));
  card.addEventListener("pointercancel", () => resetSummaryCard(card));
});
reducedMotion?.addEventListener("change", () => summaryCards.forEach(resetSummaryCard));
