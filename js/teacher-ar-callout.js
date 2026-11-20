// Coordinates are measured in CSS pixels, independently of the WebGL resolution.
export function descriptionArrow(anchor, viewport, card, frame) {
  if (!anchor || ![anchor.x, anchor.y].every(Number.isFinite) || !viewport.width || !viewport.height || !card.width || !card.height) return null;
  if (anchor.x < 0 || anchor.y < 0 || anchor.x > viewport.width || anchor.y > viewport.height) return null;
  if (card.top >= frame.top + frame.height || card.top + card.height <= frame.top) return null;
  const target = { x: viewport.left - frame.left + anchor.x, y: viewport.top - frame.top + anchor.y };
  const centre = { x: card.left - frame.left + card.width / 2, y: card.top - frame.top + card.height / 2 };
  const dx = target.x - centre.x, dy = target.y - centre.y;
  if (Math.abs(dx) <= card.width / 2 && Math.abs(dy) <= card.height / 2) return null;
  const amount = Math.min(card.width / 2 / Math.abs(dx), card.height / 2 / Math.abs(dy));
  const start = { x: centre.x + dx * amount, y: centre.y + dy * amount };
  const bend = Math.abs(dx) > Math.abs(dy) ? { x: (start.x + target.x) / 2, y: start.y } : { x: start.x, y: (start.y + target.y) / 2 };
  const point = value => `${Math.round(value.x)},${Math.round(value.y)}`;
  return `M${point(start)} L${point(bend)} L${point(target)}`;
}

export function descriptionPlacement(anchor, viewport, panel, previousSide) {
  let side = !previousSide || anchor.x < viewport.width * .4 || anchor.x > viewport.width * .6
    ? anchor.x < viewport.width / 2 ? "right" : "left" : previousSide;
  const gap = 24, margin = 12;
  const fitsRight = anchor.x + gap + panel.width <= viewport.width - margin;
  const fitsLeft = anchor.x - gap - panel.width >= margin;
  if (side === "right" && !fitsRight && fitsLeft) side = "left";
  else if (side === "left" && !fitsLeft && fitsRight) side = "right";
  const desired = side === "right" ? anchor.x + gap : anchor.x - gap - panel.width;
  const x = Math.max(margin, Math.min(Math.max(margin, viewport.width - panel.width - margin), desired));
  const limit = Math.max(8, viewport.height - panel.height - 80), minimum = Math.min(58, limit);
  const y = Math.max(minimum, Math.min(limit, anchor.y - panel.height * .45));
  return { x: Math.round(x), y: Math.round(y), side };
}

export class TeacherARCallout {
  constructor({ frame, viewport, card, rail, svg, path }) {
    Object.assign(this, { frame, viewport, card, rail, svg, path });
    this.dirty = true;
    this.observer = new ResizeObserver(() => this.refresh());
    for (const node of [frame, viewport, card, rail]) this.observer.observe(node);
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
    if (!this.enabled || !anchor) {
      this.anchor = null;
      this.hide(true);
      return;
    }
    if (!this.dirty && this.anchor?.x === anchor.x && this.anchor.y === anchor.y) return;
    this.anchor = anchor;
    if (this.dirty) {
      this.bounds = { frame: this.frame.getBoundingClientRect(), viewport: this.viewport.getBoundingClientRect(), card: this.card.getBoundingClientRect(), rail: this.rail.getBoundingClientRect() };
      this.svg.setAttribute("viewBox", `0 0 ${this.bounds.frame.width} ${this.bounds.frame.height}`);
      this.dirty = false;
    }
    const { viewport, frame, card, rail } = this.bounds;
    const position = descriptionPlacement(anchor, viewport, rail, this.side); this.side = position.side;
    const left = `${position.x}px`, topOffset = `${position.y}px`;
    if (this.rail.style.left !== left) this.rail.style.left = left;
    if (this.rail.style.top !== topOffset) this.rail.style.top = topOffset;
    if (this.rail.style.right !== "auto") this.rail.style.right = "auto";
    const offset = card.top - rail.top, top = Math.max(0, offset), bottom = Math.min(rail.height, offset + card.height);
    const placed = { left: viewport.left + position.x + card.left - rail.left, top: viewport.top + position.y + top, width: card.width, height: Math.max(0, bottom - top) };
    const d = descriptionArrow(anchor, viewport, placed, frame);
    this.hide(!d);
    if (d && this.path.getAttribute("d") !== d) this.path.setAttribute("d", d);
  }
}
