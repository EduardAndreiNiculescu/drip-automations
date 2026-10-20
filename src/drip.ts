/**
 * Idempotent drip campaigns on top of a cron and a unique-keyed log table.
 *
 *   claim -> send -> compensate
 *
 * Claiming is an INSERT into a table with a unique (contact, step) key: if
 * two cron runs overlap, only one wins and nobody gets the e-mail twice. If
 * sending fails, the claim is deleted so the next run retries. No queue, no
 * worker, no external automation tool.
 */

export type Step =
  /** Fires a fixed time after the contact's *first* action (e.g. 24 h after their first vote). */
  | { key: string; kind: "relative"; afterHours: number }
  /** Fires on a calendar date in the campaign's timezone (e.g. 3 days before the event). */
  | { key: string; kind: "fixed"; date: string };

export interface Contact {
  id: string;
  email: string;
  /** First qualifying action. Using the *latest* action instead keeps pushing active people's timer forward forever. */
  firstActionAt: Date;
  data?: Record<string, unknown>;
}

/** `YYYY-MM-DD` of `now` in a timezone (en-CA formats as ISO date). */
export function localDate(now: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}

/**
 * The single step to send now, plus the older fixed-date steps it makes obsolete.
 *
 * Relative steps go first. Among fixed steps, the latest one that is due wins,
 * and every earlier due-but-unsent one is superseded: someone who joins three
 * days before the event gets "3 days left", and must never get "7 days left"
 * on the next run.
 */
export function pickStep(steps: Step[], contact: Contact, sent: Set<string>, now: Date, timeZone: string): { send?: string; supersede: string[] } {
  for (const s of steps) {
    if (s.kind === "relative" && !sent.has(s.key) && now.getTime() - contact.firstActionAt.getTime() >= s.afterHours * 3_600_000) {
      return { send: s.key, supersede: [] };
    }
  }
  const today = localDate(now, timeZone);
  const due = steps
    .filter((s): s is Extract<Step, { kind: "fixed" }> => s.kind === "fixed" && s.date <= today)
    .sort((a, b) => b.date.localeCompare(a.date));
  if (!due.length || sent.has(due[0].key)) return { supersede: due.filter((s) => !sent.has(s.key)).map((s) => s.key) };
  return { send: due[0].key, supersede: due.slice(1).filter((s) => !sent.has(s.key)).map((s) => s.key) };
}

export interface DripStore {
  /** Steps already logged for a contact (sent or superseded). */
  logged(contactId: string): Promise<Set<string>>;
  /** Insert into the unique-keyed log. Returns false if it already exists (another run won). */
  claim(contactId: string, step: string, status: "sent" | "superseded"): Promise<boolean>;
  /** Undo a claim after a failed send, so the next run retries. */
  release(contactId: string, step: string): Promise<void>;
}

export interface Sender {
  send(contact: Contact, step: string): Promise<{ ok: boolean; reason?: string }>;
}

export interface RunReport {
  sent: number;
  results: Array<{ contact: string; step?: string; status: string }>;
}

export async function runDrip(opts: {
  contacts: Contact[];
  steps: Step[];
  store: DripStore;
  sender: Sender;
  timeZone: string;
  now?: Date;
  /** Opted out, already converted, bounced... */
  exclude?: (c: Contact) => string | null;
  /** Campaign end (inclusive), in the campaign timezone. */
  endsOn?: string;
}): Promise<RunReport> {
  const now = opts.now ?? new Date();
  const report: RunReport = { sent: 0, results: [] };
  if (opts.endsOn && localDate(now, opts.timeZone) > opts.endsOn) return report;

  for (const c of opts.contacts) {
    const reason = opts.exclude?.(c);
    if (reason) {
      report.results.push({ contact: c.id, status: `skipped_${reason}` });
      continue;
    }
    const { send, supersede } = pickStep(opts.steps, c, await opts.store.logged(c.id), now, opts.timeZone);
    for (const old of supersede) await opts.store.claim(c.id, old, "superseded");
    if (!send) {
      report.results.push({ contact: c.id, status: "nothing_due" });
      continue;
    }
    if (!(await opts.store.claim(c.id, send, "sent"))) {
      report.results.push({ contact: c.id, step: send, status: "already_claimed" });
      continue;
    }
    let result: { ok: boolean; reason?: string };
    try {
      result = await opts.sender.send(c, send);
    } catch (err) {
      result = { ok: false, reason: (err as Error).message };
    }
    if (!result.ok) {
      await opts.store.release(c.id, send);
      report.results.push({ contact: c.id, step: send, status: `failed_${result.reason ?? "unknown"}` });
      continue;
    }
    report.sent++;
    report.results.push({ contact: c.id, step: send, status: "sent" });
  }
  return report;
}

/** One contact per id, keeping the *first* action. */
export function firstActions<T extends { contactId: string; email: string; at: Date }>(rows: T[]): Contact[] {
  const byId = new Map<string, Contact>();
  for (const r of [...rows].sort((a, b) => a.at.getTime() - b.at.getTime())) {
    if (!byId.has(r.contactId)) byId.set(r.contactId, { id: r.contactId, email: r.email.toLowerCase(), firstActionAt: r.at });
  }
  return [...byId.values()];
}
