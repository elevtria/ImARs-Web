import { WebLoginState } from "../workers/web-auth-worker.js";
import { databaseQuotaFailure } from "./firestore-admin.js";
import { dashboardRefreshInterval, dashboardScope } from "./dashboard-summary.js";

const json = (body, status = 200) => Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
const copy = value => value === undefined ? undefined : structuredClone(value);
const hash = async value => Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))), byte => byte.toString(16).padStart(2, "0")).join("");

class SnapshotStorage {
  constructor(snapshot) { this.values = new Map(Object.entries(snapshot?.values || {})); this.alarm = snapshot?.alarm || null; this.changed = false; }
  async get(key) { return copy(this.values.get(key)); }
  async put(key, value) {
    if (this.values.has(key) && JSON.stringify(this.values.get(key)) === JSON.stringify(value)) return;
    this.values.set(key, copy(value)); this.changed = true;
  }
  async delete(key) { const removed = this.values.delete(key); this.changed ||= removed; return removed; }
  async getAlarm() { return this.alarm; }
  async setAlarm(value) { this.alarm = value; this.changed = true; }
  async list({ prefix = "", limit = 1000, startAfter } = {}) {
    return new Map([...this.values].filter(([key]) => key.startsWith(prefix) && (!startAfter || key > startAfter))
      .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).slice(0, limit).map(([key, value]) => [key, copy(value)]));
  }
  snapshot(revision) { return { revision, alarm: this.alarm, values: Object.fromEntries(this.values) }; }
}

// Strong reads plus ETag-conditional writes make session/attempt updates atomic
// across independent function instances. No process-local state grants access.
export class NetlifyState {
  constructor(store, env, { fetcher = fetch, now = () => Date.now(), kick = async () => {} } = {}) {
    this.store = store; this.env = env; this.fetcher = fetcher; this.now = now; this.kick = kick;
  }
  idFromName(name) {
    if (typeof name !== "string" || !name || name.length > 512) throw new Error("Invalid private state name");
    return name;
  }
  get(name) {
    this.idFromName(name);
    return { fetch: async (url, options) => {
      try {
        const request = url instanceof Request ? url : new Request(url, options);
        const action = new URL(request.url).pathname;
        if (action === "/dashboard-get") return await this.dashboard(name, await request.json());
        const body = request.method === "POST" ? await request.text() : undefined;
        // Reuse a verified upstream password response on a storage conflict. It
        // never survives this request or becomes an authentication credential.
        const proofs = new Map();
        const fetcher = (url, options) => {
          const key = url + "\n" + options?.body;
          if (!proofs.has(key)) proofs.set(key, this.fetcher(url, options).then(async response => ({ status: response.status, headers: [...response.headers], body: await response.text() })));
          return proofs.get(key).then(result => new Response(result.body, result));
        };
        return await this.transact(name, actor => actor.handle(new Request(request.url, { method: request.method,
          headers: request.headers, ...(body !== undefined ? { body } : {}) })), { fetcher });
      } catch { return json({ error: "Login protection is temporarily unavailable." }, 503); }
    } };
  }
  async transact(name, operation, { fetcher = this.fetcher, attempts = 8, kick = true } = {}) {
    const id = await hash(name), key = "state/" + id;
    for (let attempt = 0; attempt < attempts; attempt++) {
      const previous = await this.store.getWithMetadata(key, { type: "json", consistency: "strong" });
      const storage = new SnapshotStorage(previous?.data), pending = [];
      const actor = new WebLoginState({ storage, waitUntil: task => pending.push(task) }, this.env, { now: this.now, fetch: fetcher });
      const result = await operation(actor, storage);
      await Promise.all(pending);
      if (!storage.changed) return result;
      const snapshot = storage.snapshot((previous?.data?.revision || 0) + 1);
      if (JSON.stringify(snapshot).length > 8_000_000) throw new Error("Private state is too large");
      const saved = await this.store.setJSON(key, snapshot, previous ? { onlyIfMatch: previous.etag } : { onlyIfNew: true });
      if (!saved.modified) continue;
      if (name.startsWith("dashboard:")) {
        await this.publishDashboard(id, snapshot);
        await this.store.setJSON("dashboards/" + id, { name });
        if (kick && storage.alarm) await this.kick({ kind: "dashboard", name }).catch(() => {});
      }
      return result;
    }
    throw new Error("Private state changed; retry the request");
  }
  async publishDashboard(id, snapshot) {
    const key = "dashboard-view/" + id;
    const config = snapshot.values["dashboard:config"], summary = snapshot.values["dashboard:summary"];
    const pending = Boolean(snapshot.values["dashboard:job"]) || Object.keys(snapshot.values).some(key => key.startsWith("dashboard:dirty:"));
    for (let attempt = 0; attempt < 5; attempt++) {
      const previous = await this.store.getWithMetadata(key, { type: "json", consistency: "strong" });
      if ((previous?.data?.revision || 0) >= snapshot.revision) return;
      if ((await this.store.setJSON(key, { revision: snapshot.revision, config, summary: summary || null, pending, nextStepAt: snapshot.alarm }, previous ? { onlyIfMatch: previous.etag } : { onlyIfNew: true })).modified) return;
    }
    throw new Error("Dashboard publication will retry");
  }
  async dashboard(name, body) {
    if (!name.startsWith("dashboard:") || name !== "dashboard:" + body.uid || !Array.isArray(body.sections) || body.sections.length > 500 ||
        body.sections.some(section => typeof section.id !== "string" || typeof section.name !== "string")) return json({ error: "Invalid dashboard." }, 400);
    const id = await hash(name), projection = await this.store.get("dashboard-view/" + id, { type: "json", consistency: "strong" });
    const config = projection?.config, summary = projection?.summary;
    const sameScope = config?.id === body.id && config.uid === body.uid && config.scope === dashboardScope(body.sections, this.env);
    const ready = sameScope && summary?.scope === config.scope;
    const interval = dashboardRefreshInterval(summary);
    if (!sameScope || (!body.warmOnly && ready && this.now() - summary.reconciledAt >= interval && !projection.pending)) {
      return this.transact(name, async actor => json(await actor.dashboard.configure(body)));
    }
    if (!ready) {
      if (!projection?.nextStepAt || projection.nextStepAt <= this.now()) await this.kick({ kind: "dashboard", name }).catch(() => {});
      return json({ ready: false });
    }
    if (projection.pending && (!projection.nextStepAt || projection.nextStepAt <= this.now())) await this.kick({ kind: "dashboard", name }).catch(() => {});
    const { generation, scope, ...data } = summary;
    return json({ ready: true, pending: projection.pending, summary: data });
  }
  async step(name) {
    try { return await this.transact(name, async (actor, storage) => {
      if (!storage.alarm || storage.alarm > this.now()) return false;
      storage.alarm = null; storage.changed = true;
      await actor.dashboard.step();
      return Boolean(storage.alarm);
    }, { attempts: 2, kick: false }); }
    catch (error) {
      if (!databaseQuotaFailure(error)) throw error;
      await this.transact(name, async (_actor, storage) => storage.setAlarm(this.now() + 900_000), { kick: false });
      return false;
    }
  }
}
