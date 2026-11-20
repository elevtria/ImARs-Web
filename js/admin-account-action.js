import { webRequest } from "./web-login.js";
import { teacherViewCache } from "./view-cache.js";

let active = false;
// Native dialog traps focus and blocks pointer/keyboard access to the background.
export function confirmAdminAction(body, title, message, options = {}) {
  if (active) return Promise.resolve(null);
  active = true;
  const dialog = document.createElement("dialog");
  dialog.className = "admin-reauth";
  dialog.setAttribute("aria-labelledby", "adminActionTitle");
  dialog.setAttribute("aria-describedby", "adminActionMessage");
  dialog.innerHTML = `<form><h2 id="adminActionTitle"></h2><p id="adminActionMessage"></p><label>Your administrator password<input name="password" type="password" autocomplete="current-password" maxlength="4096" required></label><span role="status" aria-live="polite"></span><div class="admin-actions"><button type="button" class="ghost-btn">Cancel</button><button type="submit" class="primary-btn">Confirm</button></div></form>`;
  dialog.querySelector("h2").textContent = title;
  dialog.querySelector("p").textContent = message;
  const form = dialog.querySelector("form"), input = form.elements.password, status = dialog.querySelector('[role="status"]');
  if (options.confirmationText) {
    const label = document.createElement("label");
    label.textContent = `Type ${options.confirmationText} to confirm`;
    const confirmation = document.createElement("input");
    confirmation.name = "confirmation"; confirmation.required = true; confirmation.autocomplete = "off";
    label.append(confirmation); form.insertBefore(label, input.closest("label"));
  }
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
        if (options.confirmationText && form.elements.confirmation.value !== options.confirmationText) throw new Error("Type the confirmation phrase exactly as shown.");
        result = await webRequest(options.endpoint || "/api/admin-security/action", { ...body, password: input.value,
          ...(options.confirmationText ? { confirmation: form.elements.confirmation.value } : {}) });
        teacherViewCache().invalidate();
        dialog.close();
      } catch (error) { status.textContent = error.message; }
      finally { input.value = ""; busy = false; submit.disabled = cancel.disabled = false; }
    });
    dialog.showModal(); (form.elements.confirmation || input).focus();
  });
}
