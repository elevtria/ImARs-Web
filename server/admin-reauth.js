// Recheck the acting administrator, never the target teacher's password.
// The private auth worker enforces three failed confirmations / five minutes.
export async function confirmAdministratorPassword(env, store, actor, password, callState) {
  const fail = (message, status) => Object.assign(new Error(message), { status });
  if (actor?.role !== "admin") throw fail("Administrator access is required.", 403);
  if (typeof password !== "string" || !password || password.length > 4096) throw fail("Confirm your administrator password.", 400);
  const identity = await store.identity(actor.uid);
  if (!identity?.email || identity.disabled || identity.localId !== actor.uid) throw fail("Account verification is unavailable.", 503);
  const checked = await callState(env, "admin-security:" + actor.uid, "mobile-password", { uid: actor.uid, email: identity.email, password });
  if (!checked.ok) throw fail(checked.status === 429 ? "Too many incorrect confirmations. Try again after five minutes." : "Your administrator password could not be confirmed.", checked.status === 429 ? 429 : 400);
}
