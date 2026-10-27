export function createLoadingTracker(render, { delayMs = 0, schedule = setTimeout, cancel = clearTimeout } = {}) {
  const pending = new Set();
  let revealTimer = null;
  let visible = false;
  const reveal = () => {
    revealTimer = null;
    if (!pending.size) return;
    visible = true;
    render({ active: true, message: pending.values().next().value });
  };
  const notify = () => {
    if (!pending.size) {
      if (revealTimer !== null) cancel(revealTimer);
      revealTimer = null;
      visible = false;
      render({ active: false });
    } else if (visible || delayMs === 0) {
      reveal();
    } else if (revealTimer === null) {
      revealTimer = schedule(reveal, delayMs);
    }
  };
  return {
    get pendingCount() { return pending.size; },
    start(message) {
      const task = { ...message };
      pending.add(task);
      notify();
      let finished = false;
      return () => {
        if (finished) return;
        finished = true;
        pending.delete(task);
        notify();
      };
    },
    async run(operation, message) {
      const finish = this.start(message);
      try {
        return await operation();
      } finally {
        finish();
      }
    }
  };
}

const regions = new WeakMap();

// A read can mark its own data regions busy; it never changes the page shell.
export function startLoading(message = {}) {
  const path = message.reference?.path;
  const targets = message.target ? [message.target] : path && typeof document !== "undefined"
    ? [...document.querySelectorAll("[data-loading-path]")].filter(region =>
      region.dataset.loadingPath.split(/\s+/).some(prefix => path === prefix || path.startsWith(prefix + "/"))) : [];
  const finishes = targets.map(region => {
    let state = regions.get(region);
    if (!state) {
      state = { status: null, priorBusy: null };
      state.tracker = createLoadingTracker(({ active }) => {
        if (!active) {
          if (state.status) state.status.hidden = true;
          if (state.priorBusy === null) region.removeAttribute("aria-busy");
          else region.setAttribute("aria-busy", state.priorBusy);
          return;
        }
        if (!state.status) {
          state.status = document.createElement("p");
          state.status.className = "section-data-loading";
          state.status.setAttribute("role", "status");
          state.status.setAttribute("aria-live", "polite");
        }
        // Rendering may replace children while another request is still pending.
        if (state.status.parentNode !== region) region.prepend(state.status);
        state.status.textContent = region.dataset.loadingLabel || message.title || "Loading this section…";
        state.status.hidden = false;
        region.setAttribute("aria-busy", "true");
      }, { delayMs: 150 });
      regions.set(region, state);
    }
    if (!state.tracker.pendingCount) state.priorBusy = region.getAttribute("aria-busy");
    return state.tracker.start();
  });
  return () => finishes.forEach(finish => finish());
}

export async function withLoading(operation, message) {
  const finish = startLoading(message);
  try { return await operation(); } finally { finish(); }
}
