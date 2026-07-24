# responder-push-alerts — Durable Object backend for web-push device alerts (P1)

This is a **standalone Cloudflare Worker** that hosts the `PushRegistry` Durable Object. A Pages
project cannot define its own Durable Object, so the DO ships here and the Pages site
(`responder-tx`) binds to it (`env.PUSH`) through the Functions under `functions/api/push/`.
This directory is `export-ignore`d in `.gitattributes`, so it is **not** part of the
`wrangler pages deploy` archive; it deploys separately and never touches the static site build.

## What it holds

One well-known DO instance (`idFromName('registry')`) is the only copy of every anonymous push
subscription: endpoint URL, browser-minted `p256dh`/`auth` keys, prefs (P1: FFE on/off only,
schema forward-stable for gauge tiers/places), and language (`en`/`es`). No name, no email, no
account, no IP retention (IPs touch only a transient in-memory rate bucket). Rows expire 60 days
after their last renew; the client silently renews on each app boot while subscribed. Any 404/410
from a push service deletes the row immediately.

## Evaluator (P1: Flash Flood Emergency only)

A `*/5` Cloudflare Cron Trigger on this Worker calls the DO's `/evaluate`:

1. Fetch `api.weather.gov/alerts/active?area=TX`, classify with the client's rule
   (`FLASH FLOOD EMERGENCY` in the description, or a CATASTROPHIC flash-flood damage threat tag).
2. Keep products whose polygon bbox (else zone bbox, capped lookups; unresolvable geometry counts
   as in-AO — fail toward notifying) intersects the event AO from
   `https://respondertx.org/data/event.json` (cached 15 min, last-good on fetch failure).
3. New alert ids not in the seen-ring get one payload-free push per subscription (dedup by alert
   id; an extension/replacement product with a new id counts as new). The service worker composes
   the localized notification text client-side (P1 payload-free; encrypted payloads arrive in P2).
4. Sends drain through a queue in batches of 40 via a chained DO alarm, respecting the free-plan
   ~50-subrequest ceiling.

## Deploy (one-time + on change) — CONTROLLER STEP, needs the Cloudflare API token

```bash
cd workers/push-alerts
# uses the same CLOUDFLARE_ACCOUNT_ID / CLOUDFLARE_API_TOKEN as scripts/deploy.sh
npx -y wrangler@3.114.0 deploy
```

## VAPID keys — CONTROLLER STEP (mint offline, never in CI, never in repo)

```bash
node -e "const c=require('node:crypto');const{publicKey,privateKey}=c.generateKeyPairSync('ec',{namedCurve:'prime256v1'});const p=publicKey.export({format:'jwk'}),s=privateKey.export({format:'jwk'});const b=(x)=>Buffer.from(x,'base64url');console.log('public :',Buffer.concat([Buffer.from([4]),b(p.x),b(p.y)]).toString('base64url'));console.log('private:',s.d)"
```

- **Public key** → `VAPID_PUBLIC_KEY` in `wrangler.toml` `[vars]` (not a secret; clients fetch it
  from `/api/push/status` so a rotation propagates without an app release).
- **Private key** → Worker secret, never a repo file:
  `npx -y wrangler@3.114.0 secret put VAPID_PRIVATE_KEY` (paste the base64url `d` value).
- **Local backup** (loss recovery only): `/root/.config/responder/vapid-private-key` and
  `vapid-public-key`, mode 600 on the LAN controller host — the same convention as
  `/root/.config/responder/team-admin-token`.
- **Admin token** for the test-fire/peek ops endpoints: random value set BOTH as a Worker secret
  (`npx -y wrangler@3.114.0 secret put PUSH_ADMIN_TOKEN`, guards the local-dev forwarder) and as a
  Pages secret (`npx -y wrangler@3.114.0 pages secret put PUSH_ADMIN_TOKEN --project-name
  responder-tx`, guards `functions/api/push/admin/*`). Backup at
  `/root/.config/responder/push-admin-token`. If unset, those endpoints 403 for every request.

**Rotation runbook:** mint a new pair, `secret put` the private key, update `VAPID_PUBLIC_KEY`,
redeploy. Every existing subscription becomes undeliverable (push services reject the mismatched
JWT key); clients self-heal on their next board visit in P3, and until then sends failing 403
delete rows lazily. Devices that never reopen the board are unrecoverable by design (no identity,
nothing to migrate) — rotate deliberately, not casually.

## Bind the Pages project to the DO — CONTROLLER STEP (Cloudflare dashboard)

**Cloudflare dashboard → Workers & Pages → `responder-tx` → Settings → Functions →
Durable Object bindings → Add binding:**

- **Variable name:** `PUSH`
- **Durable Object class:** `PushRegistry`
- **Worker (script):** `responder-push-alerts`

(Add it for both Production and Preview.) After this, the Pages Functions under
`functions/api/push/` resolve `env.PUSH`. Unbound → every `/api/push/*` route returns 503 and the
client hides the card entirely (same posture as the team feature without `env.TEAM`).

## Ops verification

```bash
# public status (through Pages): configured flag, last evaluator pass, public VAPID key
curl -s https://respondertx.org/api/push/status
# token-gated registry counts (no endpoints ever disclosed)
curl -s -X POST -H "X-Admin-Token: $(cat /root/.config/responder/push-admin-token)" https://respondertx.org/api/push/admin/peek
# token-gated real test push to one stored subscription (omit endpoint = all, capped one batch)
curl -s -X POST -H "X-Admin-Token: $(cat /root/.config/responder/push-admin-token)" \
  -H 'Content-Type: application/json' -d '{"endpoint":"https://fcm.googleapis.com/..."}' \
  https://respondertx.org/api/push/admin/fire
```

## Local end-to-end verification (no deploy, no account)

```bash
cd workers/push-alerts
npx -y wrangler@3.114.0 dev --port 8798
curl -s localhost:8798/api/push/status
curl -s -XPOST localhost:8798/api/push/subscribe -d '{"subscription":{"endpoint":"https://fcm.googleapis.com/fcm/send/TEST","keys":{"p256dh":"x","auth":"y"}},"lang":"en"}'
```
