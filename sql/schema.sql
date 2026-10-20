-- The whole "workflow engine" is one unique key.
create table if not exists drip_log (
  contact_id text not null,
  step text not null,
  status text not null check (status in ('sent', 'superseded')),
  logged_at timestamptz not null default now(),
  primary key (contact_id, step)          -- the claim: a second insert fails, so no double send
);
alter table drip_log enable row level security;   -- service role only

create table if not exists email_optout (
  email text primary key,                 -- keyed on e-mail: an unsubscribe click has no session
  source text,
  created_at timestamptz not null default now()
);
alter table email_optout enable row level security;

-- Hourly trigger. The function checks a dedicated CRON_SECRET: calling it with the
-- public anon key would let anyone on the internet start a send run.
create extension if not exists pg_cron;
create extension if not exists pg_net;
-- store the secret once:  select vault.create_secret('<long random>', 'drip_cron_secret');
select cron.schedule('drip-hourly', '0 * * * *', $$
  select net.http_post(
    url := 'https://<project-ref>.supabase.co/functions/v1/drip-runner',
    headers := jsonb_build_object(
      'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'drip_cron_secret'),
      'Content-Type', 'application/json'
    )
  );
$$);
