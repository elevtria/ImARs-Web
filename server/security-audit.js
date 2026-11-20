// Trusted server writes only. No passwords, reset links, or tokens are recorded.
export const auditCollection = "webSettings/security/audit";
export function securityAudit(actor, action, targetId, details = "", now = Date.now()) {
  const id = String(9_999_999_999_999 - now).padStart(13, "0") + "_" + crypto.randomUUID().replaceAll("-", "");
  return { operation: "set", path: `${auditCollection}/${id}`, data: {
    actorId: actor.id, actorRole: actor.role, action, targetId, details, at: new Date(now).toISOString()
  } };
}
