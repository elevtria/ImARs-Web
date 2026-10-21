// Server-only administrative access. Never import this module from browser JS.
const encode = bytes => btoa(String.fromCharCode(...bytes)).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
const utf8 = value => new TextEncoder().encode(value);
let cachedToken;

export function serviceAccount(env) {
  const value = JSON.parse(env.FIREBASE_SERVICE_ACCOUNT_JSON || "null");
  if (value?.project_id !== "imars-db-a733b" || typeof value.client_email !== "string" ||
      !value.client_email.endsWith(".iam.gserviceaccount.com") || typeof value.private_key !== "string" ||
      !value.private_key.startsWith("-----BEGIN PRIVATE KEY-----")) throw new Error("Account access setup is incomplete");
  return value;
}

export async function serviceToken(env, fetcher = fetch, now = Date.now()) {
  const account = serviceAccount(env);
  if (cachedToken?.key === account.private_key && cachedToken.email === account.client_email && cachedToken.until > now + 60_000) return cachedToken.token;
  const issued = Math.floor(now / 1000);
  const payload = encode(utf8(JSON.stringify({ alg: "RS256", typ: "JWT" }))) + "." + encode(utf8(JSON.stringify({
    iss: account.client_email, scope: "https://www.googleapis.com/auth/datastore https://www.googleapis.com/auth/identitytoolkit",
    aud: "https://oauth2.googleapis.com/token", iat: issued, exp: issued + 3600
  })));
  const pem = account.private_key.replace(/-----[^-]+-----|\s/g, "");
  const key = await crypto.subtle.importKey("pkcs8", Uint8Array.from(atob(pem), char => char.charCodeAt(0)),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
  const signature = encode(new Uint8Array(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, utf8(payload))));
  const response = await fetcher("https://oauth2.googleapis.com/token", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: payload + "." + signature }), signal: AbortSignal.timeout(10_000) });
  const result = await response.json();
  if (!response.ok || typeof result.access_token !== "string" || !(result.expires_in > 0)) throw new Error("Account access unavailable");
  cachedToken = { email: account.client_email, key: account.private_key, token: result.access_token, until: now + Math.min(result.expires_in, 3600) * 1000 };
  return cachedToken.token;
}

export function decodeFields(fields = {}) {
  const value = item => {
    if ("stringValue" in item) return item.stringValue;
    if ("integerValue" in item) return Number(item.integerValue);
    if ("doubleValue" in item) return item.doubleValue;
    if ("booleanValue" in item) return item.booleanValue;
    if ("nullValue" in item) return null;
    if ("timestampValue" in item) return item.timestampValue;
    if ("mapValue" in item) return decodeFields(item.mapValue.fields);
    if ("arrayValue" in item) return (item.arrayValue.values || []).map(value);
    throw new Error("Unsupported Firestore field");
  };
  return Object.fromEntries(Object.entries(fields).map(([name, item]) => [name, value(item)]));
}

export function encodeFields(fields) {
  const value = item => {
    if (item === null) return { nullValue: null };
    if (typeof item === "string") return { stringValue: item };
    if (typeof item === "boolean") return { booleanValue: item };
    if (Number.isSafeInteger(item)) return { integerValue: String(item) };
    if (typeof item === "number" && Number.isFinite(item)) return { doubleValue: item };
    if (Array.isArray(item)) return { arrayValue: { values: item.map(value) } };
    if (item && typeof item === "object") return { mapValue: { fields: encodeFields(item) } };
    throw new Error("Invalid Firestore field");
  };
  return Object.fromEntries(Object.entries(fields).map(([name, item]) => [name, value(item)]));
}

export class FirestoreAdmin {
  constructor(env, fetcher = fetch) { this.env = env; this.fetcher = fetcher; }
  name(path) {
    if (!path.split("/").every(part => /^[A-Za-z0-9_-]{1,128}$/.test(part))) throw new Error("Invalid database path");
    return "projects/imars-db-a733b/databases/(default)/documents/" + path;
  }
  async request(suffix, options = {}) {
    const token = await serviceToken(this.env, this.fetcher);
    const response = await this.fetcher("https://firestore.googleapis.com/v1/projects/imars-db-a733b/databases/(default)/" + suffix, {
      ...options, headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" }, signal: AbortSignal.timeout(10_000)
    });
    if (response.status === 404) return null;
    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      const conflict = response.status === 409 || ['ABORTED', 'ALREADY_EXISTS', 'FAILED_PRECONDITION'].includes(body.error?.status);
      const error = new Error(conflict ? "Account state changed. Please retry signing in." : "Account access unavailable");
      error.status = conflict ? 409 : 503;
      throw error;
    }
    return response.json();
  }
  async get(path) {
    const result = await this.request("documents/" + path.split("/").map(encodeURIComponent).join("/"));
    return result ? { data: decodeFields(result.fields), updateTime: result.updateTime } : null;
  }
  async findUser(uid) {
    const rows = await this.request("documents:runQuery", { method: "POST", body: JSON.stringify({ structuredQuery: {
      from: [{ collectionId: "users" }], where: { fieldFilter: { field: { fieldPath: "uid" }, op: "EQUAL", value: { stringValue: uid } } }, limit: 2
    } }) });
    const documents = rows.filter(row => row.document).map(row => row.document);
    if (documents.length > 1) throw new Error("Duplicate Firebase UID requires administrator review");
    if (documents.length !== 1) return null;
    return { id: documents[0].name.split("/").at(-1), data: decodeFields(documents[0].fields), updateTime: documents[0].updateTime };
  }
  async activate(profileId, profile, uid, updates, role, authEmail) {
    await this.request("documents:commit", { method: "POST", body: JSON.stringify({ writes: [
      { update: { name: this.name("users/" + profileId), fields: encodeFields(updates) }, updateMask: { fieldPaths: Object.keys(updates) },
        currentDocument: { updateTime: profile.updateTime } },
      { update: { name: this.name("_accountAccess/" + uid), fields: encodeFields({ profileId, role, authEmail, active: true }) }, currentDocument: { exists: false } }
    ] }) });
  }
}
