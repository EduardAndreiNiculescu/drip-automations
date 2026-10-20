# drip-automations

**Behaviour-triggered e-mail campaigns with no workflow tool: a cron, one table with a unique key, and under 200 lines of TypeScript that can't double-send, can't spam stale messages, and retry on failure.**

Extracted from the vote-to-ticket conversion campaign of a business gala: everyone who voted publicly and hadn't bought a seat got a short sequence, a "thank you" 24 hours after their *first* vote, then reminders 7, 3 and 1 days before the event and on the day. The CRM's own workflow builder couldn't be driven by API, so the campaign ran entirely on Postgres cron + an Edge Function + Resend.

```
cron (hourly) ─▶ drip-runner ─▶ for each contact:
                                  excluded? (opted out / converted)   → skip
                                  pickStep(): what is due now?        → one step, older ones superseded
                                  claim  = INSERT (contact, step)     → unique key: a second run loses
                                  send   = e-mail provider
                                  failed? release the claim           → next run retries
```

## Why it's built like this

- **Claim → send → compensate.** The claim is an insert into `drip_log` with primary key `(contact_id, step)`. Overlapping cron runs or a manual re-run can't send twice: the loser's insert fails. A failed send deletes its claim, so the next run retries. No queue, no worker.
- **One message per run, the most relevant one.** A relative step ("24 h after the first action") goes first. Among calendar steps, the latest due one wins and **every older unsent step is marked `superseded`**.
- **Timers start at the *first* action.** Using the latest action keeps pushing active people's timer forward. In production that left 3,910 of the most engaged voters stuck, never reaching "24 h after".
- **Timezone-correct calendar.** "3 days before" is computed in the campaign's timezone, not UTC.
- **Unsubscribe that works.** HMAC opt-out tokens keyed on the e-mail (an unsubscribe click has no session), with a required secret instead of a hard-coded fallback salt, plus RFC 8058 `List-Unsubscribe` headers for the native Gmail/Outlook button.
- **Quoted-printable-safe links.** E-mail transport can turn `=d5` in a URL into a broken byte. `hrefSafe()` encodes `&` and `=` as HTML entities that survive transport and that browsers decode back.
- **The cron is authenticated** with a dedicated secret from Supabase Vault, not the public anon key that anyone could use to trigger a send run.

## The bug that made "superseded" necessary

The production version checked the calendar steps in urgency order and sent the first one due and unsent. A person who voted three days before the event got the "3 days left" e-mail, and on the very next hourly run the stale "one week to go" one, because it was due and had never been sent. Now sending a step supersedes the older ones, and a test runs three hourly cycles to prove `t7` never follows `t3`.

## Also included

`expiredHolds()`: the pure core of a cron that releases seats (or discounted offers) held for N minutes during checkout, so a 15-minute countdown on the page is honest.

## Layout

```
src/drip.ts                  pickStep, runDrip, firstActions, localDate
src/email.ts                 optOutToken / verifyOptOut, hrefSafe, listUnsubscribeHeaders
src/holds.ts                 expiredHolds
functions/drip-runner        Supabase Edge Function: contacts from votes, exclusions, Resend
sql/schema.sql               drip_log (the claim), email_optout, authenticated hourly cron
```

```bash
npm test     # 9 tests
```

They cover the timezone date, late joiners and superseding, relative-before-calendar priority, three hourly runs with no stale send, failure → release → retry, overlapping runs with no double send, exclusions, campaign end, first-action timers, opt-out tokens, QP-safe hrefs, and hold expiry.

## License

MIT
