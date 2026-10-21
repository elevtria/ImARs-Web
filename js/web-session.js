import { onAuthStateChanged, signOut as firebaseSignOut } from "./firebase-auth.js";
import { webProtectionEnabled } from "./web-login.js";
import { invalidateTeacherViews } from "./view-cache.js";
import { startSessionMonitor } from "./session-monitor.js";

const initialized = new WeakMap();

function sessionNotice() {
  const style = document.createElement("link");
  style.rel = "stylesheet";
  style.href = new URL("../css/web-session.css", import.meta.url).href;
  document.head.append(style);
  const element = document.createElement("div");
  element.className = "web-session-notice";
  element.setAttribute("role", "status");
  element.setAttribute("aria-live", "polite");
  element.hidden = true;
  const message = document.createElement("span"), button = document.createElement("button");
  button.type = "button";
  button.textContent = "Stay signed in";
  element.append(message, button);
  document.body.append(element);
  return { button, show(kind) {
    element.hidden = !kind;
    button.hidden = kind !== "idle";
    message.textContent = kind === "idle" ? "You’ll be signed out soon due to inactivity."
      : kind === "absolute" ? "Your session is ending soon. Save your work and sign in again."
      : kind === "connection" ? "Unable to check your session. Reconnecting…" : "";
  } };
}

export function initWebSession(auth) {
  if (initialized.has(auth)) return initialized.get(auth);
  const setup = (async () => {
    let enabled, ui;
    while (true) {
      try { enabled = await webProtectionEnabled(); break; }
      catch {
        ui ||= sessionNotice();
        ui.show("connection");
        await new Promise(resolve => setTimeout(resolve, 5000));
      }
    }
    if (!enabled) { ui?.show(null); return false; }
    ui ||= sessionNotice();
    ui.show(null);
    let monitor, uid;
    onAuthStateChanged(auth, user => {
      if (user?.uid === uid) return;
      monitor?.stop();
      uid = user?.uid;
      if (!uid) return;
      monitor = startSessionMonitor({
        visible: () => document.visibilityState !== "hidden",
        check: active => fetch("/api/web-auth/session", { method: "POST", credentials: "same-origin", cache: "no-store",
          headers: { "Content-Type": "application/json", "X-Web-User": uid }, body: JSON.stringify({ active }), signal: AbortSignal.timeout(10_000) }),
        notice: kind => ui.show(kind),
        onExpired: async () => {
          invalidateTeacherViews();
          document.querySelector("main")?.setAttribute("hidden", "");
          try { await firebaseSignOut(auth); }
          finally { window.location.replace("/login?reason=web-session"); }
        }
      });
    });
    for (const name of ["pointerdown", "pointermove", "keydown", "scroll", "touchstart"]) {
      window.addEventListener(name, event => { if (event.isTrusted) monitor?.activity(); }, { passive: true });
    }
    window.addEventListener("focus", () => monitor?.refresh());
    window.addEventListener("pageshow", () => monitor?.refresh());
    document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") monitor?.refresh(); });
    ui.button.addEventListener("click", () => monitor?.staySignedIn());
    return true;
  })();
  initialized.set(auth, setup);
  return setup;
}
