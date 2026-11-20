import { webRequest } from "./web-login.js";

const open = document.getElementById("forgotPasswordButton");
const dialog = document.getElementById("teacherRecoveryDialog");
const form = document.getElementById("teacherRecoveryForm");
const input = document.getElementById("recoveryTeacherId");
const status = document.getElementById("teacherRecoveryStatus");
const send = document.getElementById("sendTeacherRecovery");
const cancel = document.getElementById("closeTeacherRecovery");
let busy = false;

open.addEventListener("click", () => {
  input.value = document.getElementById("teacherId").value.trim();
  status.textContent = ""; status.removeAttribute("data-error");
  send.hidden = false; cancel.textContent = "Cancel";
  dialog.showModal(); input.focus();
});
cancel.addEventListener("click", () => dialog.close());
dialog.addEventListener("cancel", event => { if (busy) event.preventDefault(); });
dialog.addEventListener("close", () => { input.value = ""; open.focus(); });
form.addEventListener("submit", async event => {
  event.preventDefault();
  if (busy || send.hidden) return;
  const identifier = input.value.trim().toUpperCase();
  if (!/^TEACH\d{4,10}$/.test(identifier)) {
    status.textContent = "Enter your Teacher ID, for example TEACH1000.";
    status.dataset.error = "true"; input.focus(); return;
  }
  busy = true; send.disabled = cancel.disabled = input.disabled = true;
  send.setAttribute("aria-busy", "true");
  status.removeAttribute("data-error"); status.textContent = "Requesting your reset link…";
  try {
    const result = await webRequest("/api/web-auth/forgot-password", { identifier });
    status.textContent = result.message;
    send.hidden = true; cancel.textContent = "Back to sign in";
  } catch (error) {
    status.textContent = error.userMessage || "Recovery is temporarily unavailable. Please try again or contact school support.";
    status.dataset.error = "true";
  } finally {
    busy = false; send.disabled = cancel.disabled = input.disabled = false;
    send.setAttribute("aria-busy", "false");
  }
});
