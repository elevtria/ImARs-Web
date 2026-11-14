// Mirror the table's native scrollbar above it, including after data or layout changes.
document.querySelectorAll("[data-scroll-target]").forEach(scrollbar => {
  const table = document.getElementById(scrollbar.dataset.scrollTarget);
  const viewport = table?.parentElement;
  const spacer = scrollbar.firstElementChild;
  if (!viewport || !spacer) return;

  const sync = (source, target) => {
    if (target.scrollLeft !== source.scrollLeft) target.scrollLeft = source.scrollLeft;
  };
  scrollbar.addEventListener("scroll", () => sync(scrollbar, viewport), { passive: true });
  viewport.addEventListener("scroll", () => sync(viewport, scrollbar), { passive: true });

  const update = () => {
    scrollbar.hidden = viewport.scrollWidth <= viewport.clientWidth;
    spacer.style.width = `${viewport.scrollWidth}px`;
    sync(viewport, scrollbar);
  };
  const observer = new ResizeObserver(update);
  observer.observe(viewport);
  observer.observe(table);
  update();
});
