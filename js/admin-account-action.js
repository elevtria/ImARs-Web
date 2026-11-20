import { webRequest } from "./web-login.js";
import { teacherViewCache } from "./view-cache.js";

let active = false;
// Native dialog traps focus and blocks pointer/keyboard access to the background.
export function confirmAdminAction(body, title, message) {
  if (active) return Promise.resolve(null);
  active = true;
  const dialog = document.createElement("dialog");
  dialog.className = "admin-reauth";
  dialog.setAttribute("aria-labelledby", "adminActionTitle");
  dialog.innerHTML = `<form><h2 id="adminActionTitle"></h2><p></p><label>Your administrator password<input name="password" type="password" autocomplete="current-password" maxlength="4096" required></label><span role="status" aria-live="polite"></span><div class="admin-actions"><button type="button" class="ghost-btn">Cancel</button><button type="submit" class="primary-btn">Confirm</button></div></form>`;
  dialog.querySelector("h2").textContent = title;
  dialog.querySelector("p").textContent = message;
  const form = dialog.querySelector("form"), input = form.elements.password, status = dialog.querySelector('[role="status"]');
  const submit = dialog.querySelector('[type="submit"]'), cancel = dialog.querySelector('[type="button"]');
  let busy = false, result = null;
  document.body.append(dialog);
  return new Promise(resolve => {
    dialog.addEventListener("cancel", event => { if (busy) event.preventDefault(); });
    cancel.addEventListener("click", () => dialog.close());
    dialog.addEventListener("close", () => { input.value = ""; dialog.remove(); active = false; resolve(result); }, { once: true });
    form.addEventListener("submit", async event => {
      event.preventDefault();
      if (busy) return;
      busy = true; submit.disabled = cancel.disabled = true; status.textContent = "Confirming and saving…";
      try {
        result = await webRequest("/api/admin-security/action", { ...body, password: input.value });
        teacherViewCache().invalidate();
        dialog.close();
      } catch (error) { status.textContent = error.message; }
      finally { input.value = ""; busy = false; submit.disabled = cancel.disabled = false; }
    });
    dialog.showModal(); input.focus();
  });
}
