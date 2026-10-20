import assert from "node:assert/strict";
import { test } from "node:test";
import { firstActions, localDate, pickStep, runDrip, type Contact, type DripStore, type Step } from "../src/drip.ts";
import { expiredHolds } from "../src/holds.ts";
import { hrefSafe, listUnsubscribeHeaders, optOutToken, verifyOptOut } from "../src/email.ts";

const TZ = "Europe/Bucharest";
const STEPS: Step[] = [
  { key: "after24h", kind: "relative", afterHours: 24 },
  { key: "t7", kind: "fixed", date: "2026-09-18" },
  { key: "t3", kind: "fixed", date: "2026-09-22" },
  { key: "t1", kind: "fixed", date: "2026-09-24" },
  { key: "day_of", kind: "fixed", date: "2026-09-25" },
];
const at = (iso: string) => new Date(iso);
const contact = (id: string, first: string): Contact => ({ id, email: `${id}@x.example`, firstActionAt: at(first) });

test("local date follows the campaign timezone, not UTC", () => {
  assert.equal(localDate(at("2026-09-21T22:30:00Z"), TZ), "2026-09-22"); // 01:30 in Bucharest
});

test("a late joiner gets the most urgent step and older ones are superseded", () => {
  const c = contact("late", "2026-09-22T06:00:00Z");
  assert.deepEqual(pickStep(STEPS, c, new Set(), at("2026-09-22T09:00:00Z"), TZ), { send: "t3", supersede: ["t7"] });
});

test("the relative step outranks the calendar", () => {
  const c = contact("early", "2026-09-17T08:00:00Z");
  assert.deepEqual(pickStep(STEPS, c, new Set(), at("2026-09-18T09:00:00Z"), TZ), { send: "after24h", supersede: [] });
});

function memoryStore() {
  const log = new Map<string, "sent" | "superseded">();
  const store: DripStore = {
    async logged(id) { return new Set([...log.keys()].filter((k) => k.startsWith(`${id}:`)).map((k) => k.split(":")[1])); },
    async claim(id, step, status) { const k = `${id}:${step}`; if (log.has(k)) return false; log.set(k, status); return true; },
    async release(id, step) { log.delete(`${id}:${step}`); },
  };
  return { store, log };
}

test("hourly runs never send a stale step after a newer one (the bug this fixes)", async () => {
  const { store, log } = memoryStore();
  const sent: string[] = [];
  const sender = { send: async (_c: Contact, step: string) => (sent.push(step), { ok: true }) };
  const c = contact("late", "2026-09-22T06:00:00Z");
  for (const hour of ["09", "10", "11"]) {
    await runDrip({ contacts: [c], steps: STEPS, store, sender, timeZone: TZ, now: at(`2026-09-22T${hour}:00:00Z`) });
  }
  assert.deepEqual(sent, ["t3"], "t7 must never follow t3");
  assert.equal(log.get("late:t7"), "superseded");
  await runDrip({ contacts: [c], steps: STEPS, store, sender, timeZone: TZ, now: at("2026-09-23T07:00:00Z") });
  assert.deepEqual(sent, ["t3", "after24h"]);
});

test("a failed send is released and retried; overlapping runs don't double-send", async () => {
  const { store } = memoryStore();
  let fail = true;
  const sent: string[] = [];
  const sender = { send: async (c: Contact, step: string) => (fail ? { ok: false, reason: "smtp_down" } : (sent.push(`${c.id}:${step}`), { ok: true })) };
  const c = contact("a", "2026-09-10T08:00:00Z");
  const now = at("2026-09-12T08:00:00Z");
  const r1 = await runDrip({ contacts: [c], steps: STEPS, store, sender, timeZone: TZ, now });
  assert.equal(r1.results[0].status, "failed_smtp_down");
  fail = false;
  await Promise.all([1, 2].map(() => runDrip({ contacts: [c], steps: STEPS, store, sender, timeZone: TZ, now })));
  assert.deepEqual(sent, ["a:after24h"]);
});

test("exclusions and campaign end", async () => {
  const { store } = memoryStore();
  const sender = { send: async () => ({ ok: true }) };
  const contacts = [contact("buyer", "2026-09-01T08:00:00Z"), contact("optout", "2026-09-01T08:00:00Z")];
  const r = await runDrip({ contacts, steps: STEPS, store, sender, timeZone: TZ, now: at("2026-09-20T08:00:00Z"),
    exclude: (c) => (c.id === "buyer" ? "converted" : c.id === "optout" ? "opted_out" : null) });
  assert.deepEqual(r.results.map((x) => x.status), ["skipped_converted", "skipped_opted_out"]);
  const ended = await runDrip({ contacts, steps: STEPS, store, sender, timeZone: TZ, now: at("2026-09-26T08:00:00Z"), endsOn: "2026-09-25" });
  assert.equal(ended.results.length, 0);
});

test("timers start from the first action, not the latest", () => {
  const rows = [
    { contactId: "u", email: "U@X.example", at: at("2026-09-15T10:00:00Z") },
    { contactId: "u", email: "u@x.example", at: at("2026-09-12T10:00:00Z") },
  ];
  assert.deepEqual(firstActions(rows), [{ id: "u", email: "u@x.example", firstActionAt: at("2026-09-12T10:00:00Z") }]);
});

test("opt-out tokens, QP-safe hrefs, one-click headers", async () => {
  const secret = "k".repeat(40);
  const t = await optOutToken(" Ana@X.example ", secret);
  assert.ok(await verifyOptOut("ana@x.example", t, secret));
  assert.ok(!(await verifyOptOut("bob@x.example", t, secret)));
  await assert.rejects(optOutToken("a@b.example", ""));
  assert.equal(hrefSafe("https://x.example/u?e=a&t=d5"), "https://x.example/u?e&#61;a&amp;t&#61;d5");
  assert.equal(listUnsubscribeHeaders("https://x.example/u")["List-Unsubscribe-Post"], "List-Unsubscribe=One-Click");
});

test("expired holds release their seats", () => {
  const now = at("2026-09-20T12:00:00Z");
  const holds = [
    { id: "h1", status: "pending" as const, expiresAt: at("2026-09-20T11:59:00Z"), resourceId: "seat-4" },
    { id: "h2", status: "pending" as const, expiresAt: at("2026-09-20T12:10:00Z"), resourceId: "seat-5" },
    { id: "h3", status: "paid" as const, expiresAt: at("2026-09-20T11:00:00Z"), resourceId: "seat-6" },
  ];
  const r = expiredHolds(holds, now);
  assert.deepEqual(r.expire.map((h) => h.id), ["h1"]);
  assert.deepEqual(r.release, ["seat-4"]);
});
