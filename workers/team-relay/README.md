# responder-team-relay — Durable Object backend for live team location sharing

This is a **standalone Cloudflare Worker** that hosts the `TeamRelay` Durable Object. A Pages
project cannot define its own Durable Object, so the DO ships here and the Pages site
(`responder-tx`) binds to it. This directory is `export-ignore`d in `.gitattributes`, so it is
**not** part of the `wrangler pages deploy` archive — it deploys separately and never touches the
static site build.

## What it holds

One DO instance per team is the only copy of live team state: members, viewers, latest
positions, and capped breadcrumb trails. State lives in Cloudflare (SQLite-backed DO), auto-expires
via TTL, and is **never** written to the repo. See `team-relay.js` for the enforced invariants
(≥4-char handles, viewers cannot publish a position, stale/idle reaping). Teams are one of four
data-driven types (SAR, Response, Recovery, Community) via the `TEAM_TYPES` table; the type is
fixed at creation and scopes each member's profile fields (the K9 sub-model exists only for SAR),
so validation is per-type and a member cannot inject another type's role.

## Deploy (one-time + on change) — CONTROLLER STEP, needs the Cloudflare API token

```bash
cd workers/team-relay
# uses the same CLOUDFLARE_ACCOUNT_ID / CLOUDFLARE_API_TOKEN as scripts/deploy.sh
wrangler deploy
```

`wrangler.toml` here declares the DO class + a `new_sqlite_classes` migration (free-plan
SQLite DO — no paid entitlement required) and sets `workers_dev = false` so the Worker is not
publicly routable; it is reachable only through the Pages binding below.

## Bind the Pages project to the DO — CONTROLLER STEP (Cloudflare dashboard)

This binding cannot be added from `scripts/deploy.sh` without risk to the existing
`wrangler pages deploy` invocation, so set it once in the dashboard:

**Cloudflare dashboard → Workers & Pages → `responder-tx` → Settings → Functions →
Durable Object bindings → Add binding:**

- **Variable name:** `TEAM`
- **Durable Object class:** `TeamRelay`
- **Worker (script):** `responder-team-relay`

(Add it for both Production and Preview environments.) After this, the Pages Functions under
`functions/api/team/` resolve `env.TEAM` and the feature is live behind `?team=`.

Equivalent config-file alternative (if you later move Pages to a `wrangler.toml` with
`pages_build_output_dir`): a `[[durable_objects.bindings]]` entry with
`name = "TEAM"`, `class_name = "TeamRelay"`, `script_name = "responder-team-relay"` (no
migration in the Pages config — the migration lives here in the Worker).

## Master oversight view (v0.97.5) — registry + admin token — CONTROLLER STEPS

The LAN-only master oversight view (`js/master.js`) enumerates every team. It reads a **global
registry** DO (`idFromName('registry')`, in this same `TeamRelay` script — no new class, no new
migration) that records `{id, name, created}` for each team on create and holds **no** positions
or markers. Enumeration is gated by a secret admin token; without it the endpoints fail safe (403).

Three controller actions after pulling this release:

1. **Redeploy the Worker** (ships the registry `register`/`reglist`/`overview`/`peek` code):

   ```bash
   cd workers/team-relay
   npx -y wrangler@3.114.0 deploy      # same CLOUDFLARE_ACCOUNT_ID / CLOUDFLARE_API_TOKEN as scripts/deploy.sh
   ```

   No `wrangler.toml` change and no migration are needed — the registry reuses the existing
   `TeamRelay` class and `TEAM` binding.

2. **Set the admin token as a Pages secret** on the `responder-tx` project (this authorizes
   `/api/team/admin/list` and `/api/team/admin/overview`). Generate a strong random value and set
   the SAME value in step 3:

   ```bash
   # from the repo root, same CLOUDFLARE_* env as scripts/deploy.sh
   npx -y wrangler@3.114.0 pages secret put TEAM_ADMIN_TOKEN --project-name responder-tx
   # paste the token at the prompt (do NOT commit it anywhere)
   ```

   (Dashboard equivalent: Workers & Pages → `responder-tx` → Settings → Environment variables →
   add an **encrypted** variable `TEAM_ADMIN_TOKEN` for Production.) If this secret is unset, the
   admin endpoints return 403 for every request — enumeration is never open.

3. **Give the LAN server the same token** so `server.py` can proxy the admin endpoints (the token
   stays server-side; it never reaches git or the browser):

   ```bash
   TEAM_ADMIN_TOKEN='<same value as step 2>' PORT=8080 python3 server.py
   # optional override if the Pages site is not the default:
   #   TEAM_ADMIN_UPSTREAM='https://respondertx.org'
   ```

   With the token set, `/api/ping` advertises `master:true`, the board loads `js/master.js`, and
   the 🛰 command panel appears (bottom-left). Unset → no master panel, endpoints 503. The token
   value must be identical on the Pages secret and the LAN server, or the relay returns 403.

`js/master.js` is stripped from the public `wrangler pages deploy` (see `scripts/deploy.sh`), so
the oversight UI exists only on the LAN board. The `functions/api/team/admin/*` endpoints DO ship
to Pages (they must, to reach the DO) but are inert without the token.

## Local end-to-end verification (no deploy, no account)

`wrangler dev` runs the DO in workerd via Miniflare. The Worker's default `fetch` is a thin
forwarder over the exact same DO code path used in production, so it exercises the full flow:

```bash
cd workers/team-relay
wrangler dev --port 8799
# then, in another shell:
tid=$(curl -s -XPOST localhost:8799/api/team/create -d '{"name":"Test"}' | python3 -c 'import sys,json;print(json.load(sys.stdin)["teamId"])')
curl -s -XPOST "localhost:8799/api/team/$tid/join" -d '{"handle":"Alpha1","role":"member"}'
curl -s -XPOST "localhost:8799/api/team/$tid/position" -d "{\"ephemeralId\":\"...\",\"lat\":29.75,\"lon\":-99.35}"
curl -s "localhost:8799/api/team/$tid/state"
```
