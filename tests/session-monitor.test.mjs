import assert from "node:assert/strict";
import test from "node:test";
import { startSessionMonitor } from "../js/session-monitor.js";

function fixture() {
  let time = 0, timerId = 0, expires = 0, hidden = false, responder;
  const jobs = new Map(), requests = [], notices = [];
  const timing = () => ({ serverNow: time, idleUntil: time + 900_000, absoluteUntil: 43_200_000, renewAt: time + 900_000 });
  const monitor = startSessionMonitor({
    now: () => time, schedule(fn, delay) { jobs.set(++timerId, { fn, at: time + delay }); return timerId; },
    cancel: id => jobs.delete(id), visible: () => !hidden,
    check: async active => { requests.push(active); return responder ? responder(active) : Response.json(timing()); },
    onExpired: async () => { expires++; }, notice: kind => notices.push(kind)
  });
  async function advance(ms) {
    const until = time + ms;
    let count = 0;
    while (true) {
      const next = [...jobs].sort((a, b) => a[1].at - b[1].at)[0];
      if (!next || next[1].at > until) break;
      assert.ok(count++ < 2000, "monitor cannot busy-loop");
      time = next[1].at; jobs.delete(next[0]);
      await next[1].fn();
    }
    time = until;
  }
  return { monitor, advance, requests, notices, jobs, timing, expires: () => expires,
    respond: fn => { responder = fn; }, hide: value => { hidden = value; } };
}

test("background checks are passive; real activity is coalesced and returning to a tab does not manufacture activity", async () => {
  const app = fixture();
  await app.advance(60_000);
  assert.deepEqual(app.requests, [false, false, false]);
  for (let i = 0; i < 100; i++) app.monitor.activity();
  await app.advance(30_000);
  assert.equal(app.requests.filter(Boolean).length, 1);
  app.monitor.refresh(); await app.advance(0);
  assert.equal(app.requests.at(-1), false);
  app.hide(true); app.monitor.activity();
  await app.advance(30_000);
  assert.equal(app.requests.at(-1), false);
  app.monitor.stop();
  assert.equal(app.jobs.size, 0);
});

test("idle warning offers explicit renewal without clearing work or forcing a new login", async () => {
  const app = fixture();
  app.respond(active => Response.json({ ...app.timing(), idleUntil: active ? 900_000 : 50_000 }));
  await app.advance(0);
  assert.equal(app.notices.at(-1), "idle");
  app.monitor.staySignedIn(); await app.advance(0);
  assert.equal(app.requests.at(-1), true);
  assert.equal(app.notices.at(-1), null);
  assert.equal(app.expires(), 0);
});

test("activity just before an idle deadline is sent immediately, even just after a passive check", async () => {
  const app = fixture();
  app.respond(active => Response.json({ ...app.timing(), idleUntil: active ? 900_000 : 5000 }));
  await app.advance(0);
  await app.advance(500);
  app.monitor.activity(); await app.advance(0);
  assert.deepEqual(app.requests, [false, true]);
  assert.equal(app.notices.at(-1), null);
  assert.equal(app.expires(), 0);
});

test("a 401 retries using the shared cookie; confirmed expiry signs out once and stops polling", async () => {
  const app = fixture();
  let count = 0;
  app.respond(() => ++count === 1 ? new Response(null, { status: 401 }) : Response.json(app.timing()));
  await app.advance(0);
  assert.equal(app.requests.length, 2);
  assert.equal(app.expires(), 0);
  app.respond(() => new Response(null, { status: 401 }));
  await app.advance(30_000);
  assert.equal(app.expires(), 1);
  assert.equal(app.jobs.size, 0);
  app.monitor.activity(); app.monitor.refresh();
  await app.advance(60_000);
  assert.equal(app.expires(), 1);
});

test("network errors preserve pending activity and retry instead of claiming the account expired", async () => {
  const app = fixture();
  app.respond(() => { throw new Error("Offline"); });
  app.monitor.activity(); await app.advance(0);
  assert.equal(app.notices.at(-1), "connection");
  assert.equal(app.expires(), 0);
  app.respond(() => Response.json(app.timing()));
  await app.advance(5000);
  assert.equal(app.requests.at(-1), true);
  assert.equal(app.notices.at(-1), null);
});

test("activity during a pending request is retained and stopped monitors ignore late responses", async () => {
  const app = fixture();
  let finish;
  app.respond(() => new Promise(resolve => { finish = resolve; }));
  const pending = app.advance(0);
  await Promise.resolve();
  app.monitor.activity();
  finish(Response.json(app.timing())); await pending;
  app.respond(() => Response.json(app.timing()));
  await app.advance(30_000);
  assert.equal(app.requests.at(-1), true);
  app.respond(() => new Promise(resolve => { finish = resolve; }));
  const last = app.advance(30_000);
  await Promise.resolve(); app.monitor.stop();
  finish(new Response(null, { status: 401 }));
  // The queued retry also receives an expired response.
  app.respond(() => new Response(null, { status: 401 }));
  await last;
  assert.equal(app.expires(), 0);
  assert.equal(app.jobs.size, 0);
});
