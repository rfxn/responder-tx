# responder-share-links · Durable Object backend for short board links

A **standalone Cloudflare Worker** hosting the `ShareLinks` Durable Object. A Pages project cannot
define its own Durable Object, so the DO ships here and the Pages site (`responder-tx`) binds to it
(`env.SHARE`) through the Functions under `functions/api/share/` and `functions/s/`. This directory
is `export-ignore`d in `.gitattributes` (the `workers/` rule), so it is **not** part of the
`wrangler pages deploy` archive; it deploys separately and never touches the static site build.

## What it holds

One well-known DO instance (`idFromName('links')`) maps an 8-digit code to a board query string,
and nothing else: `c:<code> -> {q, created, hit}` plus a `meta` row count. No IP, no identity, no
URL other than the board's own query.

- **Format:** `https://respondertx.org/s/<8 digits>`, codes `10000000..99999999` (digits only, so
  a code survives being read over radio or phone; no leading zero, so a spreadsheet in an
  after-action report cannot strip one). `/share<digits>` is an alias (`_redirects`, 302 to `/s/`).
- **Same view, same code:** the query is normalized (sorted keys, `URLSearchParams` encoding) and
  the code is derived from SHA-256 of it. A code already held by a different view re-probes along a
  fixed per-view sequence (up to 16 probes), so a repeat share always finds its own row and storage
  grows only with distinct views. Rows are never deleted, which is what keeps that walk stable.
- **Same origin only:** a code maps to `/?<query>`, never to a URL. The create path accepts only the
  keys `buildShareUrl()` (`js/board.js`) can emit (`VIEW_KEYS`) plus the camera deep link `cam`
  (`RECORD_KEYS`), rejects duplicates, control characters and anything over 1024 characters with a
  400. `team` is excluded on purpose: an invite link is a capability URL and an 8-digit code would
  make it guessable. `tests/share-short.test.js` runs `buildShareUrl()` with every condition on and
  fails if its keys and `VIEW_KEYS` ever differ, so a new share param cannot be silently refused.
- **Consistency:** a Durable Object, not KV, because a link copied and texted out at once must
  resolve everywhere immediately. Creates run under `blockConcurrencyWhile`, so two views racing
  for one code end on distinct rows.
- **Retention:** no TTL, ever (links end up in after-action reports). `created` is set once; `hit`
  records the last resolve, written at most hourly so a viral link costs one write an hour.
- **Abuse bounds:** 60 new links per IP per 10 minutes (IPv6 bucketed per /64) in a transient
  in-memory bucket (never persisted); re-sharing a known view is free. A global cap of 500,000 rows
  answers 503 beyond it. Either refusal makes the client copy the full link instead.

## Endpoints (Pages Functions)

| route | answer |
|---|---|
| `POST /api/share` `{"q":"<query>"}` | `200 {code, url}` · `400` refused · `413` body over 4 KB · `429` rate limited · `503` unbound/down/full |
| `GET /s/<code>` (and `HEAD`) | `302` to `/<stored query>` with `Cache-Control: public, max-age=86400` · friendly bilingual `404` (unknown or malformed code) or `503` (unbound or DO down), both `no-store` |
| `GET /share<code>` | `302` to `/s/<code>` (`_redirects`) |

`sw.js` never answers a `/s/` or `/share<digits>` navigation from its cache: the shell served at
that path would boot with no query and silently drop the view.

## Client (`js/core.js`)

- `copyShortLink(longUrl, btn)`: the one copy path for any board link. The clipboard write starts
  inside the tap (Safari refuses one after a network wait): a promised `ClipboardItem` carries the
  mint; without `ClipboardItem` the link on hand is copied at once. The button says
  "✓ Link copied" for a short link and "✓ Full link copied" otherwise.
- `shortenShareUrl(longUrl)`: resolves to the short URL or to `longUrl` on any failure (3 s timeout,
  offline, non-200, LAN or any host other than `respondertx.org` / `*.responder-tx.pages.dev`).
- `shortLinkIfReady(longUrl)`: synchronous, for `navigator.share`, which also needs the tap.
- A link is minted only by an explicit Copy, never by opening the share sheet (it also hosts export).

## Deploy · CONTROLLER STEPS, in this order

The Pages side is already safe to ship first: without the binding every `/api/share` answers 503,
the client copies the full link and says "Full link copied", and `/s/` answers a 503 page.

**1. Deploy the Worker** (same `CLOUDFLARE_ACCOUNT_ID` / `CLOUDFLARE_API_TOKEN` as
`scripts/deploy.sh`; wrangler 3.114.0 only: the local 3.58 ignores the `new_sqlite_classes`
migration and `@4` needs Node 22):

```bash
cd workers/share-links
npx -y wrangler@3.114.0 deploy
```

**2. Find the new DO namespace id:**

```bash
A=https://api.cloudflare.com/client/v4/accounts/$CLOUDFLARE_ACCOUNT_ID
curl -s -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" "$A/workers/durable_objects/namespaces" \
  | python3 -c 'import sys,json; [print(n["id"], n["script"], n["class"]) for n in json.load(sys.stdin)["result"] if n.get("script")=="responder-share-links"]'
```

**3. Bind it to the Pages project** as `SHARE`, production and preview. Read the project first and
note the existing `PUSH` and `TEAM` bindings, then PATCH only the new key, then read it back and
confirm all three are present in both environments:

```bash
P=$A/pages/projects/responder-tx
H=(-H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" -H 'Content-Type: application/json')
curl -s "${H[@]}" "$P" | python3 -c 'import sys,json; d=json.load(sys.stdin)["result"]["deployment_configs"]; [print(e, sorted((d[e].get("durable_object_namespaces") or {}).keys())) for e in ("production","preview")]'
NS=<namespace id from step 2>
curl -s -X PATCH "${H[@]}" "$P" --data "{\"deployment_configs\":{\"production\":{\"durable_object_namespaces\":{\"SHARE\":{\"namespace_id\":\"$NS\"}}},\"preview\":{\"durable_object_namespaces\":{\"SHARE\":{\"namespace_id\":\"$NS\"}}}}}" \
  | python3 -c 'import sys,json; print(json.load(sys.stdin)["success"])'
curl -s "${H[@]}" "$P" | python3 -c 'import sys,json; d=json.load(sys.stdin)["result"]["deployment_configs"]; [print(e, sorted((d[e].get("durable_object_namespaces") or {}).keys())) for e in ("production","preview")]'
# expect: production ['PUSH', 'SHARE', 'TEAM'] and preview ['PUSH', 'SHARE', 'TEAM']
```

If a binding went missing, PATCH it back the same way before going further.

**4. Redeploy Pages** (`scripts/deploy.sh`): a binding change only takes effect on a fresh
`wrangler pages deploy`.

**5. Verify live:**

```bash
curl -s -X POST https://respondertx.org/api/share -d '{"q":"mlat=29.4241&mlon=-98.4936&mz=11&tab=gauges"}'
# -> {"code":"NNNNNNNN","url":"https://respondertx.org/s/NNNNNNNN"}; the same body again returns the same code
curl -sI https://respondertx.org/s/NNNNNNNN | grep -iE '^(HTTP|location|cache-control|cf-cache-status)'
# -> 302, location https://respondertx.org/?mlat=..., cache-control public, max-age=86400
curl -sI https://respondertx.org/shareNNNNNNNN | grep -iE '^(HTTP|location)'   # -> 302 /s/NNNNNNNN
curl -sI https://respondertx.org/s/12345678 | grep -iE '^(HTTP|cache-control|cf-cache-status)'
# -> 404, no-store. A zone cache rule (max-age=14400) overrides _headers on static assets; confirm
#    cf-cache-status is not HIT on a 404/503 here, or an edge could keep a miss for hours.
curl -s -X POST https://respondertx.org/api/share -d '{"q":"team=x"}'    # -> 400 param not allowed
```

**Changing the allowlist:** edit `VIEW_KEYS` / `RECORD_KEYS` in `share-links.js` and redeploy
this Worker (step 1 only). Until it is redeployed, links carrying the new key fall back to full
links, which still work.

## Local end-to-end verification (no deploy, no account)

`wrangler pages dev` binds to a DO running in another local `wrangler dev` process through the dev
registry, so the shipped Functions and DO run together in workerd with the real `_redirects` engine:

```bash
(cd workers/share-links && npx -y wrangler@3.114.0 dev --port 8797)
# in another shell, from the repo root (Functions compile from ./functions):
npx -y wrangler@3.114.0 pages dev <static dir> --port 8788 --local-protocol https \
  --compatibility-date 2025-02-24 --do SHARE=ShareLinks@responder-share-links
curl -sk -X POST https://127.0.0.1:8788/api/share -d '{"q":"mlat=29.4&mlon=-98.5&mz=11"}'
curl -skI https://127.0.0.1:8788/s/<code>
```

The client only shortens on `https://respondertx.org` and `*.responder-tx.pages.dev`, so a browser
run maps the name instead: `chromium --host-resolver-rules="MAP respondertx.org 127.0.0.1"
--ignore-certificate-errors` and open `https://respondertx.org:8788/` (block the upstream hosts
listed in `tests/README.md`). Delete the `node_modules/.mf` and `.wrangler/` dirs wrangler leaves.
