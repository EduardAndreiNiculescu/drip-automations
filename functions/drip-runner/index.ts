// Supabase Edge Function: one hourly run of the campaign.
// Contacts = everyone who did the qualifying action (here: voted) and hasn't converted (bought).
// Secrets: CRON_SECRET, OPTOUT_SECRET, RESEND_API_KEY, FROM_ADDRESS, SITE_URL.
import { createClient } from "jsr:@supabase/supabase-js@2";
import { firstActions, runDrip, type DripStore, type Step } from "../../src/drip.ts";
import { hrefSafe, listUnsubscribeHeaders, optOutToken } from "../../src/email.ts";

const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
const SITE = Deno.env.get("SITE_URL")!;

const STEPS: Step[] = [
  { key: "after24h", kind: "relative", afterHours: 24 },
  { key: "t7", kind: "fixed", date: Deno.env.get("EVENT_T7") ?? "2026-09-18" },
  { key: "t3", kind: "fixed", date: Deno.env.get("EVENT_T3") ?? "2026-09-22" },
  { key: "t1", kind: "fixed", date: Deno.env.get("EVENT_T1") ?? "2026-09-24" },
  { key: "day_of", kind: "fixed", date: Deno.env.get("EVENT_DAY") ?? "2026-09-25" },
];

const SUBJECTS: Record<string, string> = {
  after24h: "Thanks for voting: your attendee discount is waiting",
  t7: "One week to go",
  t3: "3 days left: seats are limited",
  t1: "Tomorrow is the night",
  day_of: "Tonight's the night",
};

const store: DripStore = {
  async logged(id) {
    const { data } = await db.from("drip_log").select("step").eq("contact_id", id);
    return new Set((data ?? []).map((r) => r.step as string));
  },
  async claim(id, step, status) {
    const { error } = await db.from("drip_log").insert({ contact_id: id, step, status });
    return !error; // unique violation = someone else claimed it
  },
  async release(id, step) {
    await db.from("drip_log").delete().eq("contact_id", id).eq("step", step).eq("status", "sent");
  },
};

Deno.serve(async (req) => {
  if (req.headers.get("x-cron-secret") !== Deno.env.get("CRON_SECRET")) return new Response("forbidden", { status: 403 });

  const [{ data: actions }, { data: buyers }, { data: optouts }] = await Promise.all([
    db.from("votes").select("user_id, email, created_at").not("email", "is", null),
    db.from("orders").select("email").eq("status", "paid"),
    db.from("email_optout").select("email"),
  ]);
  const converted = new Set((buyers ?? []).map((b) => (b.email as string).toLowerCase()));
  const optedOut = new Set((optouts ?? []).map((o) => (o.email as string).toLowerCase()));
  const contacts = firstActions((actions ?? []).map((a) => ({ contactId: a.user_id, email: a.email, at: new Date(a.created_at) })));

  const report = await runDrip({
    contacts,
    steps: STEPS,
    store,
    timeZone: Deno.env.get("CAMPAIGN_TZ") ?? "Europe/Bucharest",
    endsOn: Deno.env.get("EVENT_DAY") ?? "2026-09-25",
    exclude: (c) => (optedOut.has(c.email) ? "opted_out" : converted.has(c.email) ? "converted" : null),
    sender: {
      async send(c, step) {
        const unsub = `${SITE}/api/unsubscribe?email=${encodeURIComponent(c.email)}&token=${await optOutToken(c.email, Deno.env.get("OPTOUT_SECRET")!)}`;
        const res = await fetch("https://api.resend.com/emails", {
          method: "POST",
          headers: { Authorization: `Bearer ${Deno.env.get("RESEND_API_KEY")}`, "Content-Type": "application/json" },
          body: JSON.stringify({
            from: Deno.env.get("FROM_ADDRESS"),
            to: c.email,
            subject: SUBJECTS[step],
            html: `<p>${SUBJECTS[step]}</p><p><a href="${hrefSafe(`${SITE}/tickets?ref=${step}`)}">Book your seat</a></p>` +
              `<p style="font-size:11px"><a href="${hrefSafe(unsub)}">Unsubscribe</a></p>`,
            headers: listUnsubscribeHeaders(unsub),
          }),
        });
        return res.ok ? { ok: true } : { ok: false, reason: `http_${res.status}` };
      },
    },
  });
  return new Response(JSON.stringify(report), { headers: { "Content-Type": "application/json" } });
});
