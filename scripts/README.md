# Responder data pipeline — scripts & cron reference

Low-weight, locally-runnable data pipeline for the Responder flood ops board.
Composes plain `bash` + `python3` + system `cron` — no cloud workers, no new
services. Its purpose is durability: both the 15-minute public **data refresh**
and the **ops-chat processing** run from **system cron**, so neither depends on
a live Claude session being open (a session gap previously let the public board
go ~151 min stale, and left owner chat messages unanswered while the session was
suspended or mid-task).

## Scripts

| Script | Purpose |
| --- | --- |
| `fetch-snapshot.py` | One NWPS request at `captureBbox` → `data/gauges-capture.json` (full statewide capture, the durable archive) **and** `data/gauges-snapshot.json` (that capture filtered to `gaugeBbox`, the display-scoped public cold-start file). Both compact `{generated, bbox, gauges:[{lid,name,latitude,longitude,status}]}`. Aborts non-zero on HTTP error or a partial response so a bad fetch never overwrites good files: a same-bbox refresh must return at least half that file's previous count, a bbox re-target only has to clear the absolute floor of 25. Both files are validated before either is written. Writes atomically (temp file + rename). |
| `gen-roads-snapshot.py` | Archive the DriveTexas road-closure set → `data/roads-capture.json` (statewide) **and** `data/roads-snapshot.json` (filtered to `gaugeBbox`), same capture-vs-display split as the gauge fetch (best-effort; keeps prior files on fetch failure). |
| `rescue-nwps.py` | One-shot recovery: pull the NWPS 30-day observed buffer for every lid ever seen in this repo → `archive/recovered/nwps-30d/<LID>.json.gz` + `_manifest.json`. Not part of the cycle. |
| `gen-history.py` | Walk the committed `gauges-capture.json` history (falling back to `gauges-snapshot.json` before the capture split), merge the `archive/recovered/` blobs, reconstruct the pre-archive window → `data/history.json` (playback timeline). Retains every gauge; applies display scope once, at publish time. |
| `gen-crest-summary.py` | Per-gauge event peak stages for AAR/FEMA → `data/crest-summary.json`. Same retain-wide / publish-scoped split as `gen-history.py`. |
| `gen-feeds.py` | RSS `feed.xml` + `crests.ics` from the current snapshot + requests + live NWS FF alerts. |
| `cycle-check.sh` | Pre-commit validation bundle (JSON validity, JS syntax, version agreement, feed freshness, snapshot sanity, staged-file guard). |
| `deploy.sh` | Version-agreement pre-flight → `git push` → build stripped archive (drops `js/chat.js` + `js/master.js`, empty chat-outbox) → `wrangler pages deploy` → live smoke. |
| `run-cycle.sh` | **The durable cycle runner** — orchestrates all of the above. |
| `chat-poll.sh` | **The durable ops-chat processor** — instant auto-ack + tightly-scoped headless `claude -p`. |
| `chat-watchdog.sh` | **The stall watchdog** — build-capable auto-recovery when the in-session revival goes dark. See "Stall watchdog". |
| `freshness-monitor.sh` | **The public-mirror freshness monitor**: fetches respondertx.org's gauge snapshot over the network, ages its embedded stamp, cross-checks local pipeline health, and alerts the ops chat. See "Freshness monitor". |
| `install-cron.sh` | Idempotent installer/uninstaller for the data-cycle, chat-poll, stall-watchdog, **and** freshness-monitor system-cron entries. |
| `gen-lan-cert.sh` | Generate the self-signed TLS cert (`cert.pem` + `key.pem` under `/root/.config/responder/tls`, **outside** the repo) that `server.py` serves for LAN HTTPS. Idempotent (skips unless `--force`); prints the fingerprint + SANs. See "LAN HTTPS (self-signed)". |

`gen-cameras.py` is a separate poller and is **not** part of the 15-min cycle.

## The cycle (`run-cycle.sh`)

Order (matches the manual per-cycle protocol):

1. `fetch-snapshot.py` → fresh `data/gauges-capture.json` + `data/gauges-snapshot.json`
2. `gen-roads-snapshot.py` → `data/roads-capture.json` + `data/roads-snapshot.json`
3. `gen-history.py` → `data/history.json` + `data/gauge-meta.json` (reads *committed* snapshot history, so the newest frame lands next cycle and this cycle's fetch does not gate it)
4. `gen-notices.py` → `data/requests.json` (LAN intake merge; never committed by the cycle)
5. `gen-shelters.py` → `data/shelters-live.json`
6. `gen-crest-summary.py` → `data/crest-summary.json` (derived from the gauge snapshot)
7. `gen-feeds.py` → `feed.xml` + `crests.ics`
8. `gen-caltopo.py` → `data/caltopo-export.json` (derived from the gauge snapshot)
9. `cycle-check.sh --code-from-head` → validate
10. If any of the nine data files differ from `HEAD`: `git add` them **by name**, commit (author `Ryan MacDonald <ryan@rfxn.com>`), `git push origin main`, then `deploy.sh`, then a best-effort push nudge.

Properties:

- **`--dry-run`** runs the generators and validation and stops before any git/deploy — used to verify the pipeline composes.
- **Idempotent / no empty commits** — if no data file changed vs `HEAD`, it skips commit/push/deploy.
- **Partial publish** — see below. One failing source no longer blocks the whole publish.
- **Validation stays fatal** — a `cycle-check.sh` failure aborts before commit, leaving the last-good published state intact. If `deploy.sh` fails *after* commit+push, the data is already durable in git/GitHub and the next cycle redeploys.
- `set -euo pipefail`; every `cd` is guarded.

### Partial publish (one failing source does not block the rest)

On 2026-07-24T23:53Z NWPS answered `429 Too Many Requests`, `fetch-snapshot.py`
exited 1, and the cycle aborted: roads, history, crest, feeds, shelters and the
CalTopo export never regenerated and **nothing published at all**, including the
sources that were perfectly healthy. A flood board most needs to publish what it
has in exactly that situation, so generators are non-fatal now and the cycle
ships whatever refreshed.

It stays honest about what did not:

- **A failed generator's output file is never touched**, so it keeps its own
  older `generated` stamp and the board's freshness, aging and stale-suppression
  machinery marks that source stale on its own. Nothing is republished as fresh.
- **A generator DERIVED from a source that did not refresh is skipped, not run.**
  `gen-crest-summary.py` and `gen-caltopo.py` read `data/gauges-snapshot.json`;
  running them over an unchanged stale snapshot would rewrite the same numbers
  under a brand-new `generated` stamp, which is precisely publishing stale data
  as fresh. `gen-feeds.py` deliberately still runs: it also carries live NWS
  flash-flood alerts, and its `lastBuildDate` is a document build stamp rather
  than a data-currency claim, so withholding it over a gauge-API outage would
  hide fresh warnings.
- **Nothing refreshed is still a hard failure** (`exit 1`, no commit, no deploy).
- **A degraded cycle cannot sign off as a clean one.** It logs
  `=== cycle complete (DEGRADED) === refreshed: ... | failed: ... | skipped: ...`
  and exits `3`, and its commit subject reads `(auto-cron, partial)` naming the
  stale sources instead of claiming a full regen.
- The **partial-response guard in `fetch-snapshot.py` is unchanged**: a same-bbox
  refresh must still return at least half the previous gauge count, and a bbox
  re-target still only has to clear the absolute floor.

Exit codes:

| Code | Meaning |
| --- | --- |
| `0` | clean cycle (published, nothing to publish, dry-run, or another cycle holds the lock) |
| `1` | fatal: no source refreshed, or validation/commit/push failed |
| `2` | unknown argument |
| `3` | **published, but degraded**: some sources did not refresh |
| other | `deploy.sh`'s own exit code, propagated after a successful commit+push |

`freshness-monitor.sh` reads the degraded verdict out of the cycle log and, when
the mirror is stale because a source is not answering, says so instead of
blaming a dead cron. Coverage lives in `tests/run-cycle.test.sh`.

### Lock (flock)

`run-cycle.sh` holds a non-blocking `flock` on `/tmp/responder-cycle.lock`
(FD 9) for its whole run. A second invocation while one is in flight logs
`SKIP` and exits 0. Route **all** refreshes (system cron *and* any
session-driven refresh) through `run-cycle.sh` so they contend on this one
lock — never run the individual steps inline in parallel with the cron.
Override the path with `RESPONDER_CYCLE_LOCK`.

### Log

Everything (this script plus every subprocess) is tee'd to
`/var/log/responder-cycle.log` (override with `RESPONDER_CYCLE_LOG`; falls back
to `/tmp/responder-cycle.log` if `/var/log` is not writable). Each line is
UTC-timestamped. The cron entry sends its own stdout to `/dev/null` because the
script already persists the durable copy — tail the logfile to watch cycles.

## Capture bbox vs display bbox

`data/event.json` carries two boxes and they do different jobs.

- **`captureBbox`** (Texas-wide) governs what we *collect*. `fetch-snapshot.py`
  and `gen-roads-snapshot.py` query upstream at this box and archive the whole
  result to `data/gauges-capture.json` / `data/roads-capture.json`.
- **`gaugeBbox`** governs what we *display*. The capture is filtered to it to
  produce `data/gauges-snapshot.json` / `data/roads-snapshot.json`, which are
  what the client and the CalTopo export consume. `gen-history.py` and
  `gen-crest-summary.py` read the capture instead, and scope their own output.

The split exists because of a real loss. On 2026-07-23 the TS Bertha coastal
pivot narrowed `gaugeBbox` from `(-102.0, 28.0, -97.0, 31.1)` to
`(-98.0, 27.5, -93.4, 31.0)`. Both `gen-history.py` and `gen-crest-summary.py`
filter *every* frame they re-walk out of git against the *current* box, so the
next cycle did not merely change what we collected going forward: it deleted 18
days of already-collected South/Central Texas observations from the published
files. `data/history.json` fell from 575 frames / 281 gauges to 562 / 206 with
zero gauges west of -98, and `data/crest-summary.json` fell from 46 gauges and
17 majors to 4 and 1, dropping the whole Hill Country event. The pre-prune blobs
are pinned at tag `preprune-history-2026-07-23` and staged in
`archive/recovered/`.

Because capture is always wider than display, retargeting the AO can no longer
reduce what we collect. **An AO pivot changes `gaugeBbox` only.** Widen
`captureBbox`, never narrow it, and never point a generator at a capture file
without keeping the display filter on whatever it publishes.

Resolved in v0.97.97. `gen-history.py` and `gen-crest-summary.py` are now two
layers. Retention walks the capture history with no geographic filter anywhere in
the path; publication applies scope exactly once, at the end. Publication scope
is the union of **every** `gaugeBbox` this repo has ever committed, plus every
lid already published, so both terms only grow and narrowing the live display can
never un-publish a past frame, gauge or peak. `tests/gen-history.test.py` pins
that invariant, including a structural check that the retention path cannot
reference a bbox at all.

Reconstruction depth is `archiveStart` in `data/event.json`, not `start`. `start`
is a display field that moves with an AO pivot; it once moved past the first git
frame and silently killed the whole backfill stage. Reconstruction reads
`archive/recovered/nwps-30d/` before any network call and only for lids in
publication scope, so a routine 15-minute cycle never re-pulls a window it
already has.

## Recovery archive (`archive/`)

`archive/recovered/` holds provenance-tagged rescue data. It is git-tracked but
`export-ignore`d in `.gitattributes`, and `deploy.sh` fails the deploy if it ever
appears in the built deploy dir, so it never reaches Cloudflare Pages.

- `history-preprune-7a7519a.json`, `crest-summary-preprune-7a7519a.json` byte-verbatim
  `git show` extracts of the pre-prune blobs, with `_provenance.json` recording source
  commit, sha256, and before/after counts.
- `nwps-30d/` one gzipped verbatim NWPS observed response per lid, from `rescue-nwps.py`.
  That endpoint serves a 30-day rolling buffer and takes no date parameters, so anything
  older than 30 days is gone from upstream for good. This is why the rescue was run
  immediately rather than scheduled.

## Event close / re-target runbook

Closing an event (or re-targeting the board to a new one) is config + curated
data only; no code edits. All geography flows from `data/event.json`.

1. **Edit `data/event.json`:** `name`, `event`, `region`, `start` (new event
   start; drives history backfill and crest windows), `center`/`zoom`,
   `gaugeBbox` (drives display scoping: which gauges publish, roads/shelters/cameras
   scoping, and the LSR/alert in-AO filters; it no longer governs what we collect
   or what history and crest retain, see "Capture bbox vs display bbox"),
   `archiveStart` (how far back reconstruction may reach; independent of `start`,
   which is display only), `aoPresets` (sub-AO pills; omit for Full AO only),
   `tideStations` (coastal events only; omit or empty inland and the coastal
   water-level card does not render), and optionally
   `tropicalAutoEnable: false` to pin the NHC tracker auto-default off (it is
   otherwise data-driven: it engages only while TX has an active tropical
   warning/watch).
2. **Refresh curated data for the new AO:** `data/requests.json` seeds,
   `data/resources.json`, `data/records.json`; rerun `gen-cameras.py` (its AO
   bbox comes from event.json).
3. **Validate, then let the cron propagate:** run `scripts/cycle-check.sh`; the
   next `:08/:23/:38/:53` `run-cycle.sh` fetches the new-bbox gauge snapshot
   and regenerates roads/history/crest/feeds. History and crest depth rebuild
   from new-bbox snapshots over subsequent cycles (first cycle commits the
   first new-AO frame; playback depth grows from there). The snapshot guard is
   bbox-aware: a bbox change only has to clear the absolute gauge floor, not
   50% of the old event's count.
4. **Verify:** board title/tab name, map center and Full AO pill extent, gauge
   markers inside the new AO, roads layer scoped to the new bbox, no coastal
   card for an inland event, `feed.xml` `<title>` carries the new name. Commit
   `data/event.json` plus the regenerated data files by name, then deploy.

## Chat processor (`chat-poll.sh`)

Owner ops-chat messages typed in the app (💬 panel → `POST /api/chat` →
`data/chat-inbox.jsonl`) used to be processed **only** while a live interactive
Claude session was open and idle; a suspended or busy session left messages
unanswered (msg 69 sat unprocessed for many minutes). `chat-poll.sh` gives chat
the same **system-cron durability** the data cycle already has — it is resumable
from any session because it does not depend on one.

### Two-tier design

1. **Instant auto-ack (no LLM).** The moment new inbox lines appear, the script
   appends one `{"ts", "role":"action", "text":"message received HH:MMZ —
   processing"}` entry to `data/chat-outbox.json` using plain `python3` (never
   the LLM), written atomically (temp + rename). The owner is **never met with
   silence**, even if the LLM step is slow or fails. This step does **not**
   advance the cursor. It fires **once per new batch** — an ack-cursor
   (`data/.chat-ack-cursor`, override `RESPONDER_CHAT_ACK_CURSOR`) records the
   last-acked inbox line so a stuck LLM step doesn't spam "received" every run.
2. **Headless `claude -p` processing (single-writer).** The script then invokes
   the `claude` CLI in headless print mode with the fixed, trusted chat-poll
   protocol prompt. `claude` is **read-only**: it reads the new inbox lines (and
   the outbox for context) and emits **one consolidated reply on stdout** — it
   holds **no file-write tool at all**. The **trusted wrapper** captures that
   stdout and is the **sole writer** of `data/chat-outbox.json`: it re-reads the
   **current** outbox, appends the reply as `{"ts","role":"claude","text"}`, and
   swaps it in via temp + atomic rename after validating JSON. Because the merge
   re-reads the live file (never a pre-call snapshot) and there is **no full-file
   backup/restore anywhere**, a reply written concurrently by a live session
   **cannot be reverted**. The wrapper — not the LLM — advances `data/.chat-cursor`
   only after the merge succeeds; on any failure the cursor is left unadvanced and
   the outbox is untouched by the failed run (the owner already got the auto-ack).
   A per-batch attempt budget (`RESPONDER_CHAT_MAX_ATTEMPTS`, default 3) bounds
   retries: a message that keeps timing out posts an honest "the ops session will
   follow up" note and **defers to the interactive session instead of looping**.

### Cost model

`claude` is invoked **only when there are new inbox lines**. The common path —
inbox line count ≤ cursor — logs `no new messages` and exits immediately with
**zero LLM calls**, so running every 3 minutes is cheap. Cost is therefore
proportional to the number of owner messages, not to the poll frequency. One
`claude -p` run processes the whole new batch in a single invocation.

### Tool-permission scoping (security)

The inbox is **attacker-influenceable** — anyone on the LAN can `POST /api/chat`
— so an autonomous scheduled LLM with tool access is a prompt-injection concern.
The headless `claude` therefore runs with the **tightest viable scope**, not a
blanket bypass:

```
timeout -k 20 180 claude -p "<fixed trusted protocol prompt>" \
  --allowedTools "Read" \
  --disallowedTools "Bash Edit Write WebFetch WebSearch Task" \
  --output-format text < /dev/null
```

- **No `--dangerously-skip-permissions` / no `bypassPermissions`.** `--permission-mode`
  is intentionally omitted (the CLI has no `default` choice; the plain headless
  mode is used). In headless print mode, any tool not pre-approved via
  `--allowedTools` is denied — there is no interactive prompt to accept it — so
  the allowlist is effectively a strict allow-only set.
- **Read-only: no file writes, no shell, no network.** `claude` only needs `Read`
  to see the inbox/outbox; it emits the reply on **stdout**, so it needs no write
  tool at all. `Edit`/`Write` are **explicitly denied** alongside `Bash` (removes
  RCE, the highest-impact injection outcome) and `WebFetch`/`WebSearch`/`Task`
  (block data-exfil/SSRF and unscoped subagents). Even a fully successful
  prompt-injection cannot write **any** file, run a command, or reach the network
  — the worst it can do is produce junk reply text, which lands only in the
  LAN-only outbox that the public mirror strips entirely.
- **The outbox is written only by the trusted wrapper**, never by the LLM, so
  there is no LLM/session write race on the outbox and the prompt tells the LLM
  *not* to touch `data/.chat-cursor` — it has no file-write access at all.
- **Timeout is hard-bounded.** `timeout -k 20 180` sends SIGTERM at 180s and
  SIGKILL 20s later, so a hung `claude` cannot outlive the poll interval; on
  timeout the outbox is untouched and the attempt budget defers to the session.
- **Fixed trusted prompt.** The protocol prompt is built by the script (not
  taken from the inbox) and explicitly instructs the LLM to treat message text
  strictly as data and to refuse embedded instructions that would change its
  rules, tools, or touched files, or ask it to run commands / deploy / edit app
  source.

**Residual risk (documented, accepted):** an autonomous scheduled LLM still
processes attacker-influenceable text, but with **read-only tools** the only
thing an injection can influence is the reply **text** the wrapper appends to the
LAN-only outbox — it **cannot** write any file, execute shell, reach the network,
push, or deploy. The trusted wrapper JSON-validates and atomically writes the
outbox; the public mirror strips the chat surface entirely (`deploy.sh` drops
`js/chat.js` + `js/master.js` and ships an empty outbox), and `cycle-check.sh` re-validates before
any commit. This read-only posture supersedes the earlier `Edit(outbox)`-scoped
variant: because `claude` now emits its reply on stdout and holds no write tool,
no file — not even the outbox — is reachable by a compromised run.

### Safe / ack-only mode & flags

- `chat-poll.sh --dry-run` — compute counts, write the auto-ack to a **temp
  copy** (the real outbox is untouched), print the exact `claude` command **and
  prompt without firing it**, and leave the cursor unchanged. Use it to inspect
  behavior with no cost and no double-processing.
- `chat-poll.sh --ack-only` — do the instant auto-ack but **skip the LLM step**.
  Lets the controller stage the cron in a no-LLM safe mode first (verify the ack
  fires end-to-end), then switch to full processing. The script also degrades to
  ack-only automatically if `claude` is not on `PATH` or the credentials file is
  missing.
- Auth: headless `claude` uses the non-interactive credentials at
  `~/.claude/.credentials.json` (no interactive login needed for cron).
- Tunables: `RESPONDER_CHAT_TIMEOUT` (default `180`s around the `claude` call),
  `RESPONDER_CHAT_KILL_AFTER` (default `20`s SIGKILL grace), `RESPONDER_CHAT_MAX_ATTEMPTS`
  (default `3` per-batch LLM retries before deferring to the session),
  `RESPONDER_CHAT_LOCK`, `RESPONDER_CHAT_LOG`, `RESPONDER_CHAT_ACK_CURSOR`,
  `RESPONDER_CHAT_ATTEMPTS` (retry-state file, default `/tmp/responder-chat-attempts`).
  `RESPONDER_CHAT_INBOX`/`_OUTBOX`/`_CURSOR` override the file paths (used by the
  test harness); `RESPONDER_CHAT_CLAUDE_CMD` swaps the `claude` binary for a stub.

### Lock (flock)

`chat-poll.sh` holds its **own** non-blocking `flock` on
`/tmp/responder-chat-poll.lock` (FD 9) — **separate** from run-cycle's
`/tmp/responder-cycle.lock`, so chat processing and the data cycle never block
each other. A second chat-poll while one is in flight logs `SKIP` and exits 0.

### Log

Tee'd to `/var/log/responder-chat-poll.log` (override `RESPONDER_CHAT_LOG`;
falls back to `/tmp/responder-chat-poll.log`). Each line is UTC-timestamped. Note
`*.log` and the chat data files are git-ignored; add `data/.chat-ack-cursor` to
`.gitignore` alongside `data/.chat-cursor` (it is LAN-only runtime state — the
data cycle stages files by name and never sweeps it in, but keep it untracked).

## Stall watchdog (`chat-watchdog.sh`)

The ops chat has three delivery tiers. Two ride **system cron** and never miss:
the instant `--ack-only` poll, and the data cycle. The tier that can actually
*fulfill* a request (build/deploy/answer) is the **in-session revival** — a
durable `CronCreate` tick that re-enters a live Claude session. That tick can
silently stop being delivered to an alive, idle session: on 2026-07-21..23 it
went dark for ~34h and let one owner message wait ~11h, while the two system
crons kept running perfectly. `chat-watchdog.sh` closes that gap by putting the
build-capable recovery on the reliable system-cron substrate.

Each `*/3` run is cheap: it exits immediately unless a message has waited past
`STALL_THRESHOLD` (default 720s, i.e. longer than the 10-min in-session tick)
with `data/.chat-cursor` un-advanced. Only then does it fire **one**
build-capable headless `claude -p` (`--permission-mode bypassPermissions`) with
the same drain+act+ship+advance-cursor mandate as the revival tick, and verify
the cursor moved afterward.

Guardrails bound the blast radius:

- **Single-flight** `flock` on `/tmp/responder-chat-watchdog.lock` — a recovery
  in flight makes later `*/3` ticks `SKIP`.
- **Cooldown** (`COOLDOWN`, default 900s) between fires, recorded before launch
  so a crash still honors it.
- **Per-cursor attempt budget** (`MAX_ATTEMPTS`, default 3): after that many
  fires without the cursor advancing, it stops and posts one honest outbox note
  instead of looping builds forever.
- **Drain marker** (`data/.chat-drain-active`): a live session that touched it
  within `DRAIN_STALE` (default 1800s) is presumed mid-build, so the watchdog
  defers rather than race a second build.
- **Kill switch**: `touch data/.chat-watchdog-off` disables recovery entirely.

Security: this **softens the read-only-cron boundary by design** (owner
decision). It is delay-gated (never fires on a fresh POST, only after the
in-session path has missed the window), the drain prompt treats message text
strictly as governed data, and the guardrails cap cost. Log tee's to
`/var/log/responder-chat-watchdog.log` (falls back to `/tmp`).

## Freshness monitor (`freshness-monitor.sh`)

Every durable job above watches something *local*. None of them notice the worst
failure mode: **respondertx.org keeps serving a stale flood picture and nobody
finds out**. One host carries the data cron, the LAN server, the git push, and
the Pages deploy, so a dead host, a broken deploy path, or a stuck CDN copy all
end the same way, with the public board frozen at an old crest while the room
believes it. `freshness-monitor.sh` checks the **published mirror over the
network**, not local state, and says which of those three actually broke.

Each run:

1. **Fetches the live mirror** (`https://respondertx.org/data/gauges-snapshot.json`,
   cache-busted) and ages its embedded `generated` stamp. The data cron publishes
   4x/hour, so the ladder sits well above one missed cycle: **WARN at 45 min**
   (3 missed cycles), **CRITICAL at 90 min** (6 missed cycles).
2. **Reads local pipeline health**: the age of the local cycle output
   (`data/gauges-snapshot.json`), the age of the last commit touching it, and the
   last `deploy OK` in the cycle log.
3. **Attributes the fault** from those two halves. Local output stale means the
   cycle or its host is down. Local output fresh but the commit not landing means
   the commit and push path broke. Both current with a stale mirror means the
   publish path (deploy or Cloudflare) is at fault.
4. **Alerts the ops chat** (`data/chat-outbox.json`) as one `action` entry,
   written with the same re-read plus atomic-rename swap every other writer uses,
   so a concurrent session reply is never clobbered. It never touches
   `data/.chat-cursor`.

Fail-safe and quiet by construction:

- **A fetch failure is not staleness.** Consecutive failures are counted; a lone
  transient error logs and exits 0. Only `RESPONDER_MONITOR_FAIL_STREAK`
  failures in a row (default 3, i.e. 45 min at the installed cadence) raise an
  `UNREACHABLE` alert.
- **Transition-gated with a cooldown.** An alert posts when the verdict changes
  or after `RESPONDER_MONITOR_COOLDOWN` (default 6h), so a multi-day outage costs
  a handful of entries, not one per run. Recovery posts exactly one notice.
- **No prior state is normal.** A missing state file, missing outbox, missing
  cycle log, or missing git history all degrade to "unknown" and never fabricate
  an alert or crash (upgrade path from any earlier version).
- Single-flight `flock` on `/tmp/responder-freshness-monitor.lock`; state in
  `/tmp/responder-freshness-state` (`verdict streak last_alert_epoch`), where a
  reboot reset costs at most one extra alert.

Flags and tunables: `--dry-run` computes and logs the verdict, writing neither
the outbox nor the state file (use it to check the board by hand). Exit code is
`0` when fresh or deferring, `1` on any alerting verdict. Overrides:
`RESPONDER_MONITOR_URL`, `_WARN_MIN`, `_CRIT_MIN`, `_FAIL_STREAK`, `_COOLDOWN`,
`_TIMEOUT`, `_STATE`, `_LOCK`, `_LOG`, `_OUTBOX`, `_SNAPSHOT`, plus
`RESPONDER_CYCLE_LOG` for the deploy-history read. Log tees to
`/var/log/responder-freshness.log` (falls back to `/tmp`).

### Operator runbook: what to do when it fires

Run `scripts/freshness-monitor.sh --dry-run` first to see the current verdict and
the three local ages, then act on the cause line it prints:

| Alert says | Do this |
| --- | --- |
| the data cycle is not producing fresh local output | `tail -50 /var/log/responder-cycle.log`, confirm the cron is still installed (`crontab -l`), clear a stale `/tmp/responder-cycle.lock` if a run died holding it, then `scripts/run-cycle.sh` by hand. |
| the cycle is running and publishing what it can, but a source is not refreshing | The pipeline is healthy; one upstream is not. `grep 'WARN:\|SKIP:' /var/log/responder-cycle.log \| tail -20` names it. For an NWPS `429` this usually clears itself, so confirm nothing local is hammering the API (see "Browser verification" in `tests/README.md`) and let the next cycle retry. |
| the commit and push path is not landing | Run `git status` and `git log --oneline -3` in the repo. Usually a push rejection (remote moved) or a dirty tree blocking the cycle: `git pull --rebase origin main`, then `scripts/run-cycle.sh`. |
| the publish path (deploy or Cloudflare) is serving stale data | Run `scripts/deploy.sh` by hand and read the pre-flight output. Most often the Cloudflare token is unreadable (see "Deploy token / ansible-vault") or wrangler failed. The data is already safe in git; the deploy is the only missing step. |
| UNREACHABLE | Check the site from another network before touching the pipeline. If respondertx.org is genuinely down, this is a Cloudflare or DNS problem, not a data problem, and the local pipeline needs no action. |

Test coverage lives in `tests/freshness-monitor.test.sh` (fresh, stale, transient
failure, streak, cooldown, fresh-install, recovery); it uses a `file://` mirror
URL, so it never touches the network or the real repo data.

## Cron schedule & install

`install-cron.sh` manages independent system-cron entries. The default target is
the **data-refresh cycle** (`8,23,38,53 * * * *`); `--chat` / `--chat-ack-only`
manage the **chat-inbox poll** (`*/3 * * * *`); `--watchdog` manages the **stall
watchdog** (`*/3 * * * *`); `--monitor` manages the **freshness monitor**
(`13,28,43,58 * * * *`, offset ~5 min after each data cycle). Each target is
grep-guarded on its own command path, so managing one leaves the others intact.

```bash
# data-refresh cycle (default target) — idempotent, safe to re-run
/root/admin/work/proj/responder/scripts/install-cron.sh
/root/admin/work/proj/responder/scripts/install-cron.sh --dry-run   # preview only
/root/admin/work/proj/responder/scripts/install-cron.sh --remove

# chat-inbox poll — FULL headless-claude processing (controller/owner decision)
/root/admin/work/proj/responder/scripts/install-cron.sh --chat --dry-run
/root/admin/work/proj/responder/scripts/install-cron.sh --chat
/root/admin/work/proj/responder/scripts/install-cron.sh --chat --remove

# chat-inbox poll — ack-only (no-LLM) safe mode, for staged rollout
/root/admin/work/proj/responder/scripts/install-cron.sh --chat-ack-only

# stall watchdog — build-capable auto-recovery (controller/owner decision)
/root/admin/work/proj/responder/scripts/install-cron.sh --watchdog --dry-run
/root/admin/work/proj/responder/scripts/install-cron.sh --watchdog
/root/admin/work/proj/responder/scripts/install-cron.sh --watchdog --remove

# public-mirror freshness monitor (read-only network check, alerts the ops chat)
/root/admin/work/proj/responder/scripts/install-cron.sh --monitor --dry-run
/root/admin/work/proj/responder/scripts/install-cron.sh --monitor
/root/admin/work/proj/responder/scripts/install-cron.sh --monitor --remove
```

Installed crontab entries (marker comment on its own line above each):

```
# responder-tx durable data-refresh cycle (managed by install-cron.sh)
8,23,38,53 * * * * /root/admin/work/proj/responder/scripts/run-cycle.sh >/dev/null 2>&1
# responder-tx durable chat-inbox poll (managed by install-cron.sh)
*/3 * * * * /root/admin/work/proj/responder/scripts/chat-poll.sh --ack-only >/dev/null 2>&1
# responder-tx durable chat stall-watchdog (managed by install-cron.sh)
*/3 * * * * /root/admin/work/proj/responder/scripts/chat-watchdog.sh >/dev/null 2>&1
# responder-tx public-mirror freshness monitor (managed by install-cron.sh)
13,28,43,58 * * * * /root/admin/work/proj/responder/scripts/freshness-monitor.sh >/dev/null 2>&1
```

The installer greps the crontab for the command path and strips any prior
managed lines for that target before re-adding, so re-running is a no-op on the
entry count. `--chat` prints a security notice (autonomous headless-claude on
attacker-influenceable input) — enabling it is a controller/owner decision.

## Deploy token / ansible-vault (required for unattended runs)

`deploy.sh` self-fetches the Cloudflare credentials — `run-cycle.sh` does **not**
need to export anything:

- `CLOUDFLARE_ACCOUNT_ID` is hard-coded in `deploy.sh`.
- `CLOUDFLARE_API_TOKEN` is read at deploy time via `ansible-vault view` of
  `rfxn-infra/ansible/inventory/group_vars/all/vault.yml`
  (key `vault_cloudflare_api_token_admin`).

For an **unattended** (cron) run, `ansible-vault` must find the vault password
without prompting. This host is already configured for that:
`rfxn-infra/ansible/ansible.cfg` sets
`vault_password_file = ~/.config/rfxn-infra/vault-pw` (present, mode `0600`),
and `deploy.sh` `cd`s into that ansible dir before calling `ansible-vault`, so
the setting applies automatically. If the pipeline is ever moved to a host
without that file, provide the password non-interactively via
`ANSIBLE_VAULT_PASSWORD_FILE=/path/to/vault-pw` (or a matching `ansible.cfg`).
Without it, `deploy.sh` blocks on a password prompt and the cron cycle hangs.

## Relationship to the session-only Claude crons

System cron is the **primary** driver for both data refresh and chat. Once
`install-cron.sh` (and `--chat`) are active, the session-only Claude crons are
**redundant** and should be disabled:

- **Data refresh** — both paths write the same six files and push to the same
  branch, so leaving both on causes double-commits. Disable the session data
  cron.
- **Chat poll** — the session poll and the system poll would both process the
  inbox, but they can't double-process: they contend on the cursor, and a
  fresh interactive session should **not** re-answer already-processed lines
  because the cursor has already advanced past them. The two are further
  protected by the `flock` (`/tmp/responder-chat-poll.lock`) — if the session
  ever ran `chat-poll.sh` while the system cron held the lock, the second run
  logs `SKIP` and exits. Net: the system cron becomes the durable primary; the
  session chat poll is redundant and safe to retire.

Keep session tooling for human-in-the-loop work (news sweeps,
`requests.json`/`resources.json` curation, app releases and deploys); leave the
mechanical data refresh and the first-line chat reply to system cron.

## LAN HTTPS (self-signed)

`server.py` serves the board over HTTPS so the browser treats it as a **secure
context**. That is what unlocks field GPS: `getCurrentPosition` refuses to run on
plain HTTP at a LAN IP, so without HTTPS the locate-me features are blocked.

1. Generate the cert once on the server host:

```bash
/root/admin/work/proj/responder/scripts/gen-lan-cert.sh
```

It writes `cert.pem` (644) and `key.pem` (600) to
`/root/.config/responder/tls/`, a path **outside the repo** so the private key is
never committed. The default SANs cover `IP:192.168.2.250`, `IP:127.0.0.1`, and
`DNS:localhost`; add more (a second board IP, a hostname) as arguments or via
`RESPONDER_TLS_EXTRA_SANS`. Re-running is a no-op unless you pass `--force`.

2. Restart `server.py`. When both cert and key are present and readable it:
   - serves HTTPS on `:8443` (`HTTPS_PORT`, default 8443),
   - runs a tiny plain-HTTP listener on `:8080` (`PORT`, default 8080) that
     `301`-redirects the initial `http://host:8080/...` navigation to
     `https://host:8443/...` (host taken from the request, path and query kept).

   If the cert is absent or unreadable, `server.py` falls back to the current
   behavior: plain HTTP on `:8080`, printing a one-line notice that HTTPS is
   disabled. The server always boots either way.

3. Browsers show a **one-time self-signed warning** the first time each device
   loads `https://192.168.2.250:8443/`. Click through it (Advanced, then proceed)
   and the board loads; the browser remembers the exception. This is expected for
   a LAN self-signed cert, and is the trade for a secure context without a public
   certificate authority.

**No crontab or env change is required.** `server.py` defaults
`RESPONDER_TLS_CERT` and `RESPONDER_TLS_KEY` to the standard
`/root/.config/responder/tls/` path, so the existing `@reboot ... server.py`
crontab line picks up HTTPS automatically once the cert exists. Set
`RESPONDER_TLS_CERT`, `RESPONDER_TLS_KEY`, `HTTPS_PORT`, or `PORT` only when a
non-default layout is needed.
