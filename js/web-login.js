let configuration;

export function visitUser() {
  try { return JSON.parse(sessionStorage.getItem("imars-web-visit-v1"))?.uid || ""; }
  catch { return ""; }
}
export async function webRequest(path, body, options = {}) {
  const uid = visitUser();
  const response = await fetch(path, {
    method: "POST", credentials: "same-origin", cache: "no-store",
    headers: { "Content-Type": "application/json", ...(uid ? { "X-Web-User": uid } : {}) },
    body: JSON.stringify(body), signal: AbortSignal.timeout(30_000), ...options
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) {
    let message = result.error || "The website service is unavailable. Please try again.";
    if (result.retryAfter) {
      const minutes = Math.ceil(result.retryAfter / 60);
      message += minutes >= 60 ? ` Try again in about ${Math.ceil(minutes / 60)} hour(s).` : ` Try again in about ${minutes} minute(s).`;
    }
    if (response.status === 401 && !path.endsWith("/login")) window.dispatchEvent(new Event("imars-session-ended"));
    throw Object.assign(new Error(message), { userMessage: message, code: result.code, status: response.status });
  }
  return result;
}
export function webProtectionEnabled() {
  configuration ||= fetch("/api/web-auth/config", { cache: "no-store", credentials: "same-origin", signal: AbortSignal.timeout(10_000) }).then(async response => {
    const result = await response.json();
    if (!response.ok || result.enabled !== true || result.backend !== true) throw new Error("Website account setup is incomplete. Please contact website maintenance.");
    return true;
  }).catch(error => {
    configuration = undefined;
    throw Object.assign(new Error("Website account setup is unavailable. Please contact website maintenance."), { userMessage: error.message });
  });
  return configuration;
}
export async function protectedWebLogin(identifier, password, portal) {
  await webProtectionEnabled();
  const result = await webRequest("/api/web-auth/login", { identifier, password, portal });
  if (!result.user?.uid || result.user.role !== portal) throw new Error("Sign-in could not be verified.");
  return result.user;
}
export const closeWebSession = () => webRequest("/api/web-auth/logout", {}, { keepalive: true });
