// Coordinates are measured in CSS pixels, independently of the WebGL resolution.
export function descriptionArrow(anchor, viewport, card, frame) {
  if (!anchor || ![anchor.x, anchor.y].every(Number.isFinite) || !viewport.width || !viewport.height || !card.width || !card.height) return null;
  if (anchor.x < 0 || anchor.y < 0 || anchor.x > viewport.width || anchor.y > viewport.height) return null;
  if (card.top >= frame.top + frame.height || card.top + card.height <= frame.top) return null;
  const target = { x: viewport.left - frame.left + anchor.x, y: viewport.top - frame.top + anchor.y };
  const below = card.top >= viewport.top + viewport.height - 2;
  const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
  let start, bend;
  if (below) {
    start = { x: clamp(target.x, card.left - frame.left + 12, card.left - frame.left + card.width - 12), y: card.top - frame.top };
    bend = { x: start.x, y: (start.y + target.y) / 2 };
  } else {
    const right = card.left >= viewport.left + viewport.width - 2;
    start = { x: card.left - frame.left + (right ? 0 : card.width), y: clamp(card.top - frame.top + card.height / 2, 12, frame.height - 12) };
    bend = { x: (start.x + target.x) / 2, y: start.y };
  }
  const point = value => `${Math.round(value.x)},${Math.round(value.y)}`;
  return `M${point(start)} L${point(bend)} L${point(target)}`;
}

export class TeacherARCallout {
  constructor({ frame, viewport, card, rail, svg, path }) {
    Object.assign(this, { frame, viewport, card, rail, svg, path });
    this.dirty = true;
    this.observer = new ResizeObserver(() => this.refresh());
    for (const node of [frame, viewport, card]) this.observer.observe(node);
    rail.addEventListener("scroll", () => this.refresh(), { passive: true });
  }
  refresh() { this.dirty = true; }
  hide(value) {
    if (this.hidden === value) return;
    this.hidden = value;
    if (value) this.svg.setAttribute("hidden", ""); else this.svg.removeAttribute("hidden");
  }
  setEnabled(value) {
    if (this.enabled !== value) this.refresh();
    this.enabled = value;
    if (!value) this.hide(true);
  }
  update(anchor) {
    if (!this.enabled || !anchor) { this.hide(true); return; }
    if (this.dirty) {
      this.bounds = { frame: this.frame.getBoundingClientRect(), viewport: this.viewport.getBoundingClientRect(), card: this.card.getBoundingClientRect() };
      this.svg.setAttribute("viewBox", `0 0 ${this.bounds.frame.width} ${this.bounds.frame.height}`);
      this.dirty = false;
    }
    const d = descriptionArrow(anchor, this.bounds.viewport, this.bounds.card, this.bounds.frame);
    this.hide(!d);
    if (d && this.path.getAttribute("d") !== d) this.path.setAttribute("d", d);
  }
}
