let configuration;
export function webProtectionEnabled() {
  configuration ||= fetch("/api/web-auth/config", { cache: "no-store" }).then(async response => {
    // A plain static development server has no Pages Functions. When protection
    // is enabled in Cloudflare, middleware still requires its signed session.
    if (response.status === 404) return false;
    const text = await response.text();
    if (response.ok && !response.headers.get("Content-Type")?.includes("application/json")) return false;
    const result = JSON.parse(text);
    if (!response.ok) throw new Error(result.error || "Login protection is unavailable.");
    return result.enabled === true;
  }).catch(() => {
    configuration = undefined; // A temporary outage may be retried safely.
    const error = new Error("Login protection is temporarily unavailable. Please contact website maintenance.");
    error.userMessage = error.message;
    throw error;
  });
  return configuration;
}

export async function protectedWebLogin(identifier, password, portal) {
  const response = await fetch("/api/web-auth/login", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ identifier, password, portal })
  });
  const result = await response.json();
  if (!response.ok) {
    let message = result.error || "Sign-in could not be completed.";
    if (result.retryAfter) {
      const minutes = Math.ceil(result.retryAfter / 60);
      message += minutes >= 60 ? ` Try again in about ${Math.ceil(minutes / 60)} hour(s).` : ` Try again in about ${minutes} minute(s).`;
    }
    const error = new Error(message);
    error.userMessage = message;
    throw error;
  }
  return result.email;
}

export async function closeWebSession() {
  if (!await webProtectionEnabled()) return;
  const response = await fetch("/api/web-auth/logout", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: "{}", keepalive: true
  });
  if (!response.ok && response.status !== 404) throw new Error("Could not close the website session. Please retry signing out.");
}
