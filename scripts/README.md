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
| `fetch-snapshot.py` | One NWPS request at `captureBbox` → `data/gauges-capture.json` (full statewide capture, the durable archive) **and** `data/gauges-snapshot.json` (that capture clipped to `gaugeBbox` and the `aoArea` outline plus its border buffer, the display-scoped public cold-start file). Both compact `{generated, bbox, gauges:[{lid,name,latitude,longitude,status}]}`. Aborts non-zero on HTTP error or a partial response so a bad fetch never overwrites good files: a same-scope refresh must return at least half that file's previous count, a bbox or aoArea re-target only has to clear the absolute floor of 25. A partial capture writes neither file; a display scope under its floor keeps the previous display file but still writes the capture. Writes atomically (temp file + rename). |
| `aoarea.py` | The display AO rule (inside `gaugeBbox`, then inside the `event.json` `aoArea` outline or within its `bufferMi`), imported by `fetch-snapshot.py`, `gen-crest-summary.py` and `cycle-check.sh`. Twin of `js/core.js` `aoContains()`; `tests/ao-area.test.js` holds both to one set of verdicts. |
| `gen-roads-snapshot.py` | Archive the DriveTexas road-closure set (the MapLarge condition table drivetexas.org draws) → `data/roads-capture.json` (statewide) **and** `data/roads-snapshot.json` (filtered to `gaugeBbox`), same capture-vs-display split as the gauge fetch (best-effort; keeps prior files and exits non-zero on a failed, truncated, or stalled read, the last meaning upstream has not re-imported in 30 minutes). |
| `rescue-nwps.py` | One-shot recovery: pull the NWPS 30-day observed buffer for every lid ever seen in this repo → `archive/recovered/nwps-30d/<LID>.json.gz` + `_manifest.json`. Not part of the cycle. |
| `gen-history.py` | Walk the committed `gauges-capture.json` history (falling back to `gauges-snapshot.json` before the capture split), merge the `archive/recovered/` blobs, reconstruct the pre-archive window → `history/index.json` + content-hashed immutable `history/day/*.json`, plus `data/history.json` as a bounded compatibility copy and `data/gauge-meta.json`. Retains every gauge; applies display scope once, at publish time. |
| `gen-notices.py` | Merge LAN intake posts into `data/requests.json`. Runs in the cycle but its output is never committed by it. |
| `gen-shelters.py` | Live shelter status → `data/shelters-live.json`. Publishes OPEN only where a source states it. |
| `gen-crossings-status.py` | Jurisdiction-reported low-water-crossing status → `data/crossing-status.json`. Only non-open rows publish, because the feed timestamps a record change rather than a confirmation. |
| `gen-changes.py` | The Feed's "What changed" stream → `data/changes.json`, with its diff state in `data/changes-state.json` (committed, `export-ignore`d). Diffs each source against the state the previous run left and appends crests, flood-stage changes, NWS warnings issued, upgraded and ended, TxDOT flood closures, crossing closures, TranStar risk areas and shelters, each stamped with the source's own time or labelled as detection time. A source whose stamp did not advance, or that declares a failed read, is carried untouched and emits nothing; an absence counts only after two fresh reads (an hour for TranStar and for NWS products with no end time). First run and an unreadable state baseline silently. One source that fails to read or diff is carried while the rest publish. Exits 3 (written, degraded) when its own NWS read or a diff failed; `run-cycle.sh` logs that as written, not as a kept previous file, and signs the cycle off degraded with `partial: changes`. Events are kept seven days by when they were seen. See `INTERNAL-NOTES.md` "What changed stream". |
| `changescheck.py` | The publish bounds for `data/changes.json`, one module three callers use: `gen-changes.py` drops any line that fails them, `cycle-check.sh` gates on them (a missing or crashing checker only warns and skips that one check), and `run-cycle.sh` runs it before validation and, on a failure, restores both change files from `HEAD` (or drops them when `HEAD` has none that pass) and signs the cycle off degraded, so a derived log can never stop a flood publish. |
| `gen-wildfire.py` | Reported wildfire incidents from Texas A&M Forest Service and NIFC WFIGS → `data/wildfire.json`. Points, never perimeters. Each source publishes its own `ok`/`failed` status and its own upstream capture stamp, so an empty-but-valid read (the normal Texas state for most of the year) is distinguishable from a read that failed. Unreported acreage and containment publish as `null`, never as `0`. |
| `gen-transtar-flood.py` | Houston TranStar Roadway Flood Warning System → `data/transtar-flood.json`. Each entry is an area TranStar rates at high risk of roadway flooding, never a confirmed closure. An empty feed publishes `ok` with count `0`; a failed or unparseable read publishes `failed` with a `null` count, or `carried` with the last good warnings for up to an hour, and exits non-zero. Central local timestamps are converted to UTC. |
| `gen-crest-summary.py` | Per-gauge event peak stages for AAR/FEMA → `data/crest-summary.json`. Same retain-wide / publish-scoped split as `gen-history.py`, and the listing is also clipped to the `aoArea`. |
| `gen-feeds.py` | RSS `feed.xml` + `crests.ics` from the current snapshot + requests + live NWS FF alerts. |
| `gen-caltopo.py` | CalTopo / SARTopo GeoJSON layer → `data/caltopo-export.json`, derived from the gauge snapshot. |
| `cycle-check.sh` | Pre-commit validation bundle, eighteen gating checks: JSON validity, JS syntax, version agreement, feed freshness, snapshot sanity, staged-file guard, 911-gate Escape immunity, the event-config brand hook, chat-cursor monotonicity, the data-contract schemas, the 911 footer on every lens, the USGS bbox area cap, the offline warm depth, out-of-cycle artifact age, hazard allowlist agreement, cron bootstrap sanity, the export completeness claim, and the AO area (the `aoArea` outline parses, every region anchor sits inside it, and the clipped display keeps enough gauges for `fetch-snapshot.py` to publish; warn-only in the data lane). It also prints one advisory `NOTE`/`WARN` on revival-tick cadence, which is scheduler config and deliberately outside the gate count. That advisory compares three live sources rather than a written-down constant: the armed cron, the watchdog's stall threshold, and the gate's quiet window. It reports the tick interval and daily fire count, and warns if the stall threshold has fallen below the tick interval or if the tick is armed for hours the gate can only refuse. |
| `deploy.sh` | Version-agreement pre-flight → test gate at HEAD (`node --test`, the python suites, the shell suites, `cycle-check.sh`) → `git push` → build stripped archive (drops `js/chat.js` + `js/master.js`, empty chat-outbox) → `wrangler pages deploy` → live smoke. The strip gate asks for every stripped path twice: cache-busted (the origin, and the pass/fail condition) and plain (the CDN edge, warned about by name but never fatal, since a zone-level cache rule is dashboard config a deploy cannot fix). Staging is a fresh `mktemp -d` per run, removed on every exit path, so the cron deploy and a hand-run deploy can never share a directory; set `RESPONDER_DEPLOY_DIR` to pin the path and keep the artifact for inspection (the caller then owns it, and two runs pointed at one path can still collide). |
| `run-cycle.sh` | **The durable cycle runner** — orchestrates all of the above. |
| `chat-poll.sh` | **The durable ops-chat processor** — instant auto-ack + tightly-scoped headless `claude -p`. |
| `chat-watchdog.sh` | **The stall watchdog** — build-capable auto-recovery when the in-session revival goes dark. See "Stall watchdog". |
| `tick-gate.sh` | **Admission control for the revival tick** — a zero-LLM verdict (`INBOX` / `ALERT` / `BACKLOG` / `IDLE`) the tick reads before doing anything else. See "Tick gate". |
| `tick-burn.py` | Measures what the revival tick actually costs, attributing model requests and tokens from the session transcripts to the tick that caused them. Reports cache-read per tick and, more usefully, per request. Read-only, never published (`deploy.sh` asserts `scripts/` is absent from the artifact), and reports `UNKNOWN` with exit 3 rather than zero when no transcripts can be read. |
| `freshness-monitor.sh` | **The public-mirror freshness monitor**: fetches respondertx.org's gauge snapshot over the network, ages its embedded stamp, cross-checks local pipeline health, and alerts the ops chat. See "Freshness monitor". |
| `install-cron.sh` | Idempotent installer/uninstaller for the data-cycle, chat-poll, stall-watchdog, **and** freshness-monitor system-cron entries. |
| `gen-lan-cert.sh` | Generate the self-signed TLS cert (`cert.pem` + `key.pem` under `/root/.config/responder/tls`, **outside** the repo) that `server.py` serves for LAN HTTPS. Idempotent (skips unless `--force`); prints the fingerprint + SANs. See "LAN HTTPS (self-signed)". |

Four generators run out of band because their inputs are near-static, and none is
part of the 15-minute cycle: `gen-cameras.py` (the camera inventory →
`data/cameras.json`), `gen-records.py` (the NWPS all-time crest of record per gauge
→ `data/records.json`), `gen-river-sentry.py` (river-sentry tower positions →
`data/river-sentry.json`), and `gen-tide-meta.py` (a coordinate for every tide station
in `event.json` → `data/tide-meta.json`). Re-run them by hand after an AO change or
when a source network changes.

Out of band is not unwatched. Each refuses to overwrite a good file from a degraded
run, and each treats an output that exists but will not read as a reason to stop
rather than as an empty one: an unreadable baseline is not a first run, and using it
as one publishes an upstream dropout as a retirement. `gen-cameras.py` and
`gen-records.py` also measure the new set against what was last published, per camera
network and per record count, because a fixed floor does not follow the fleet as it
grows. `cycle-check.sh` check n ages `data/cameras.json` and `data/records.json`, so a
hand-run that stops happening fails the release lane instead of going unnoticed; the
data lane only warns, because a stale camera inventory must never stop a flood publish.

They stay off the 15-minute cycle deliberately. Their inputs do not change on that
cadence, `gen-cameras.py` alone makes thousands of upstream liveness probes per run,
and an unattended run would leave the working tree holding camera rows the cycle does
not stage, which `deploy.sh` (shipping `git archive HEAD`) would not publish anyway.

## Shell conventions

Every external coreutil in `scripts/*.sh` carries a `command` prefix: `command rm`,
`command mv`, `command cp`, `command cat`, `command mkdir`, `command mktemp`,
`command date`, `command tr`, `command tee`, `command wc`, `command dirname`,
`command seq`, `command sleep`, `command timeout`, `command chmod`. Bash builtins
(`printf`, `echo`, `cd`, `[`) stay bare, and non-coreutils (`git`, `curl`, `jq`,
`python3`, `node`, `flock`, `crontab`, `grep`, `awk`, `openssl`) are out of scope.

This is the rfxn workspace rule, applied here as written rather than exempted. The
rule's stated rationale is PATH portability on pre-usr-merge distros, which this
repo does not ship to: `scripts/` is deleted from the public artifact by
`deploy.sh` and runs only on the ops host. The rationale is therefore weaker here
than in APF/BFD/LMD, but the prefix is a semantic no-op, so an exemption would buy
nothing and cost a standing carve-out that every future agent has to rediscover and
re-litigate. A repo-local exception also invites the same argument in a project
that genuinely does ship to CentOS 6.

Bare coreutils elsewhere in a file are not a precedent: the workspace rule says so
explicitly, and this repo was mixed (13 bare call sites plus one `command mv`)
before the sweep. `tests/*.test.sh` is deliberately excluded, matching the
workspace carve-out for test files.

Verify with the workspace sweep, anchored greps first and then word-boundary,
since `^\s*cmd` misses occurrences inside `$()`, after `;`, or mid-line:

```bash
grep -rn '^\s*cp \|^\s*mv \|^\s*rm ' scripts/
grep -rnE '\b(rm|mv|cp)\b' scripts/*.sh | grep -v 'command '
grep -rn '\bcat\b' scripts/*.sh | grep -v 'command cat' | grep -v 'cat <<'
```

## The cycle (`run-cycle.sh`)

Order (matches the manual per-cycle protocol):

1. `fetch-snapshot.py` → fresh `data/gauges-capture.json` + `data/gauges-snapshot.json`
2. `gen-roads-snapshot.py` → `data/roads-capture.json` + `data/roads-snapshot.json`
3. `gen-transtar-flood.py` → `data/transtar-flood.json` (ahead of `gen-history.py`, whose long pole cannot then squeeze it)
4. `gen-history.py` → `history/index.json` + `history/day/*.json` + `data/history.json` + `data/gauge-meta.json` (reads *committed* snapshot history, so the newest frame lands next cycle and this cycle's fetch does not gate it)
5. `gen-notices.py` → `data/requests.json` (LAN intake merge; never committed by the cycle)
6. `gen-shelters.py` → `data/shelters-live.json`
7. `gen-crossings-status.py` → `data/crossing-status.json`
8. `gen-wildfire.py` → `data/wildfire.json` (two independent sources; either may degrade alone)
9. `gen-crest-summary.py` → `data/crest-summary.json` (derived from the gauge snapshot)
10. `gen-feeds.py` → `feed.xml` + `crests.ics`
11. `gen-caltopo.py` → `data/caltopo-export.json` (derived from the gauge snapshot)
12. `gen-changes.py` → `data/changes.json` + `data/changes-state.json` (last: after every source it diffs, and behind the flood feeds)
13. `changescheck.py`, then `cycle-check.sh --code-from-head` → validate (a change log outside its bounds is restored from `HEAD`, never fatal)
14. If any file in `DATA_FILES` differs from `HEAD`: `git add` them **by name**, commit (author `Ryan MacDonald <ryan@rfxn.com>`), then `deploy.sh`, then a best-effort push nudge. The cycle does **not** push: `deploy.sh` gates HEAD first and pushes on the far side of that gate, so a red suite reaches neither origin nor the mirror. The commit still precedes the gate because the artifact is `git archive HEAD`; a local commit is not a publish.

Properties:

- **Committed code, working-tree data**: see below.
- **`--dry-run`** runs the generators and validation and stops before any git/deploy — used to verify the pipeline composes.
- **Idempotent / no empty commits** — if no data file changed vs `HEAD`, it skips commit/push/deploy.
- **Partial publish** — see below. One failing source no longer blocks the whole publish.
- **Validation stays fatal** — a `cycle-check.sh` failure aborts before commit, leaving the last-good published state intact. If `deploy.sh` fails *after* commit+push, the data is already durable in git/GitHub and the next cycle redeploys.
- `set -euo pipefail`; every `cd` is guarded.

### The cycle runs committed code (v0.98.10)

The cron fires every 15 minutes against a working tree an agent may be mid-edit
in. Running the tree's generators therefore published half-finished code as
production data, and it caught three separate agents in one night: an
uncommitted `gen-caltopo.py` published a crest export before its release commit
landed, and an uncommitted `gen-history.py` wrote a bounded `data/history.json`
while the committed validator still demanded the whole record, which failed the
05:53Z cycle and left the public mirror 30 minutes stale.

So the cycle materializes `HEAD` into a throwaway `git worktree` and runs the
generators, `cycle-check.sh` and `deploy.sh` from there, the same fix
`deploy.sh` itself got in v0.97.85. Only `scripts/` is checked out, because that
is the only code the cycle executes.

The split that makes this work is **code from HEAD, data from the working
tree**. Every generator resolves its paths through `RESPONDER_ROOT`, which the
cycle exports as the real repo root, so a generator running out of the
throwaway tree still reads the live `data/event.json` and still writes `data/`,
`history/`, `feed.xml` and `crests.ics` into the real repo. That is what keeps
`data/event.json` a **data** file: re-targeting a live event takes effect on the
very next cycle, with no commit and no release. `cycle-check.sh` takes the same
variable, so its data lane still validates the working tree the cycle is about
to commit and its staged-file guard still reads the real index.

- A generator that ignored `RESPONDER_ROOT` would resolve its output into the
  throwaway tree, publish nothing and still report OK. That failure is silent,
  so `tests/run-cycle.test.sh` asserts statically that every generator the
  cycle invokes honors the variable.
- **`--allow-dirty-code`** runs the working-tree pipeline on purpose, the
  counterpart to `deploy.sh --allow-dirty-functions`, behind a loud banner. Use
  it when hand-testing an uncommitted generator against real data.
- Without that flag, uncommitted work under `scripts/` is not silently ignored:
  the cycle logs the file list, says it is running `HEAD` instead, and keeps
  publishing.
- `run-cycle.sh` itself is the one file still read from the working tree. It is
  the bootstrap that materializes everything else, and it names itself in that
  same dirty-file list when it is the one edited.

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
  `=== cycle complete (DEGRADED) === refreshed: ... | failed: ... | timed out: ... | skipped: ...`
  and exits `3`, and its commit subject reads `(auto-cron, partial)` naming the
  stale sources instead of claiming a full regen.

### Step and cycle time budgets

The cycle holds a **non-blocking** `flock`, so a generator that hangs past the
15-minute window makes the *next* scheduled cycle log `SKIP` and exit. One hung
upstream therefore stops the board publishing for as long as it lasts. Every
generator runs under `timeout -k 20 <budget>`, and the generator phase as a whole
runs under an aggregate budget (`RESPONDER_CYCLE_BUDGET_S`, default 600s).

- **A timed-out step is treated exactly like a failed one**: killed, previous
  output untouched, the cycle publishes everything else and signs off DEGRADED.
  Every generator writes its output by rename, which is what makes "killed" and
  "failed" the same fact on disk instead of a half-written file.
- **Timeouts are reported in their own bucket**, apart from failures. Both stale
  the same source, but an unreachable upstream is somebody else's outage while a
  step that times out every cycle means the budget is too tight, and only the log
  tells them apart.
- **When the aggregate budget runs short, a step's budget is squeezed** to what is
  left, and a step with under 5s left is not started at all (GNU `timeout` reads
  a budget of `0` as *no* timeout).
- `gen-history.py` is the long pole and additionally bounds its own **network**
  stage (`RESPONDER_BACKFILL_BUDGET_S`, default 300s). The archive walk and the
  retention ratchet are never time-bounded. Truncated reconstruction resumes next
  cycle, because previously reconstructed frames are re-merged from the published
  record before backfill runs.

Budgets are sized from the logged per-step distribution; see `INTERNAL-NOTES.md`
"Data-cycle step budgets". `tests/run-cycle.test.sh` asserts that the aggregate
budget plus a publish reserve still fits the cron interval, so making the cron
more frequent or raising the budget fails a test rather than disarming the guard.
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

`freshness-monitor.sh` reads the degraded verdict out of the cycle log and the
last run's outcome out of the cycle status file (below), and, when the mirror is
stale because a source is not answering or the cycle itself is failing, says so
instead of blaming a dead cron. Coverage lives in `tests/run-cycle.test.sh`.

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

### Cycle status file

A sign-off line only exists when a cycle reaches `cycle_end()`. From 2026-09-05
to 2026-09-28 a crash-corrupted `refs/heads/main` failed every run at the
materialize step, no run ever signed off, and the freshness monitor, reading
only sign-offs and data ages, blamed a dead cron 609 times while the cron ran
every 15 minutes. So every run that gets past the lock now records its outcome,
from an `EXIT` trap, whatever path it exits by:

```json
{
  "finished_at": "2026-09-28T12:08:31Z",
  "finished_epoch": 1790597311,
  "exit_code": 1,
  "stage": "materialize",
  "first_error": "ERROR: could not materialize HEAD scripts/ at /tmp/responder-pipeline.Ab12Cd: fatal: invalid reference: HEAD (--allow-dirty-code runs the working tree instead)",
  "consecutive_failures": 2300,
  "failing_since": "2026-09-05T01:23:04Z"
}
```

- Path: `/var/log/responder-cycle-status.json`, falling back to
  `/tmp/responder-cycle-status.json` when `/var/log` is not writable, overridable
  with `RESPONDER_CYCLE_STATUS`. Written to a temp file and renamed into place.
- `stage` is the last stage entered: `lock`, `materialize`, `generators`,
  `validate`, `commit`, `deploy`, `nudge`, or `signoff` for a run that signed off.
- `first_error` is the first `ERROR:` line the run logged, else its last logged
  line; `null` on success. A materialize failure quotes git's own `fatal:` line.
- `consecutive_failures` counts runs in a row that exited with anything other
  than `0` or `3`, and `failing_since` is when that streak began. Exit `0` and
  exit `3` (published, degraded) reset both.
- A lock `SKIP` and a `--dry-run` are not runs and never touch the file.

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

## Tick gate (`tick-gate.sh`)

The in-session revival tick is the only ops tier that costs model tokens. The
other four (`run-cycle.sh`, `chat-poll.sh --ack-only`, `freshness-monitor.sh`,
`backup.sh`) are pure Python and shell and cost nothing, and `chat-watchdog.sh`
costs nothing until it actually fires.

The tick's cost is dominated by re-reading an accumulated session context, not by
the work it does. Measure it rather than estimating it: `tick-burn.py --days 7`
attributes real model requests and tokens to the tick that caused them, reading
the session transcripts. It reports the unit that actually governs, **cache-read
tokens per request**, which was 155k on 2026-08-31. That number is a property of
session age, not of the tick: the same `IDLE` verdict cost 222k in a fresh
session and 1.06M in a saturated one, a 12x spread for identical work.

Three things follow. Firing less often helps linearly. Making an idle tick
terminate in one tool call instead of a full survey helps more. And firing at all
during a window where the gate can only refuse is pure loss, which is why the
cron's hour field mirrors the quiet window rather than running 24h.

`tick-gate.sh` is that one tool call. It prints a verdict the tick obeys:

| Verdict | Meaning |
| --- | --- |
| `INBOX <n>` | n unprocessed owner messages. Drain and act. **Never suppressed.** |
| `ALERT <what> <detail>` | A monitored fault has held past its threshold, e.g. `ALERT freshness CRITICAL for 75m since 2026-09-28T10:13Z` or `ALERT backup FAIL for 130m since …`. Diagnose and fix it before anything else. The slot is claimed as it is reported. |
| `BACKLOG` | Inbox clear and a discretionary work slot was available. The slot is claimed as it is reported. |
| `IDLE <why>` | Stop immediately, before reading anything else. |

Priority is `INBOX`, then `ALERT`, then `BACKLOG`, then `IDLE`. Line 2 carries the
evidence; when a held fault is being rate-limited it is named there on every
verdict (`freshness CRITICAL held 240m, its next ALERT slot in 60m`), so a tick
that stops still sees it.

`ALERT` exists because of 2026-09-05..28: the freshness monitor posted a CRITICAL
alert to the ops chat every hour for 24 days, nobody acted, and a tick that did
fire could only answer `IDLE`. The gate reads the two state files the monitor
already keeps, `RESPONDER_MONITOR_STATE` (the mirror verdict, whose fifth column
is when it began) and `RESPONDER_BACKUP_STATE` (the backup verdict, third
column), at the same default paths the monitor writes; `tests/tick-gate.test.sh`
asserts the two scripts agree on those paths and that the gate parses what the
monitor really writes.

- **Conditions**: the mirror verdict `CRITICAL`, and the backup verdict `FAIL`.
  Freshness outranks backup when both hold; the other gets the next tick.
- **Threshold** (`RESPONDER_TICK_ALERT_AFTER_MIN`, default 60): a fault younger
  than this is left to the monitor's own ops-chat alert. A state line written
  before the start column existed never raises `ALERT` until the monitor rewrites
  it, which it does on its next run.
- **Per-condition cooldown** (`RESPONDER_TICK_ALERT_COOLDOWN`, default 3h): at
  most one `ALERT` slot per condition per window, recorded in
  `data/.tick-gate-alert-state` (`RESPONDER_TICK_ALERT_STATE`, git-ignored, one
  `<condition> <epoch>` line each). Across the 16 active hours a fault the tick
  cannot fix therefore costs at most six working ticks a day, not all 32.

Deciding "no backlog item is ready" is itself the expensive part of a tick, so
the rate limit binds *before* that decision rather than after it: a `BACKLOG` or
`ALERT` verdict claims its slot under a `flock` as it reports it, whether or not
the tick goes on to ship. `--peek` reports without claiming.

Throttles, all env-overridable, none of which can delay an owner message:

- **Backlog cooldown** (`RESPONDER_TICK_BACKLOG_COOLDOWN`, default 6h) between
  discretionary slots. This is the main lever: the owner's continuous-improvement
  thesis is served by a few substantive releases a day, not by forty shallow
  wake-ups that each pay the context tax. A working tick averages 6.7M cache-read
  tokens against a gated tick's 776k, so each slot removed is worth roughly nine
  idle ones.
- **Quiet hours** (`RESPONDER_TICK_QUIET_START` / `_END`, default 01:00-09:00
  local) pause discretionary work and `ALERT` alike; a held fault waits for the
  first active-hours tick. The window may wrap midnight; equal values disable it.
- **Drain marker** (`data/.chat-drain-active`), read on the same `DRAIN_STALE`
  clock the watchdog uses, so two actors never drain the same message. It defers
  `ALERT` too: the draining session is already live in the repo.
- **Override**: `touch data/.tick-gate-off` bypasses quiet hours, the backlog
  cooldown and the `ALERT` cooldown, and restores continuous work. It is a
  throttle bypass, not a kill switch: with it present, a held fault raises
  `ALERT` on every tick.

The inbox check runs first and outranks every throttle, so the throttles trade
away only self-directed work, never responsiveness to the owner. An owner message
still gets an instant ack from the `*/3` poll, a substantive reply from the next
tick, and the watchdog behind both.

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
`STALL_THRESHOLD` (default 2100s, i.e. longer than the 30-min in-session tick)
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
- **Refuses a dirty tree**: if any tracked file differs from HEAD outside the
  data cycle's own lane, the run does not start. It logs each path, posts one
  rate-limited outbox note (`DIRTY_NOTE_COOLDOWN`, default 6h), and burns
  neither an attempt nor the cooldown. A build session started on top of
  somebody else's half-finished edits commits them.
- **Quarantines its own leftovers**: after the run, any tracked file still
  differing from HEAD is written to a patch under
  `/tmp/responder-watchdog-quarantine/` (`QUARANTINE_DIR`) and restored with
  `git checkout HEAD --`. The patch is written first; if it cannot be written,
  the restore is skipped, because a dirty tree beats losing the work. This runs
  on every path, not only on a timeout: a run that finished without committing
  what it edited is equally publishable.

Why the tree checks exist: on 2026-07-25 a recovery was killed on timeout
(`rc=124`) with uncommitted edits across `data/event.json` and four `js/` files.
The `js/` edits could not ship, because the cycle runs committed code, but the
generators read `data/event.json` **from the working tree**, so the half-written
copy widened the AO before any release carried it. The cycle's own regenerated
outputs (`data/gauges-snapshot.json`, `history/`, `feed.xml`, `crests.ics` and
the rest of `DATA_FILES`) are excluded from both checks: reverting one would
race a live publish, and the next cycle rewrites it from upstream anyway.
Untracked files are excluded too, since `git archive` ships HEAD and the cycle
stages only named paths, so a stray untracked file is inert.

An isolated worktree was considered instead and rejected: the recovery's whole
deliverable (`data/chat-outbox.json`, `data/.chat-cursor`) lives in the shared
tree, so a worktree would land the reply in a directory that is then deleted,
converting a visible dirty tree into a silently dropped owner message.

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
   (`data/gauges-snapshot.json`), the age of the last commit touching it, the
   last `deploy OK` in the cycle log, the cycle's **last sign-off**, and the
   **cycle status file** (see "Cycle status file" under the cycle section).
3. **Attributes the fault** from those two halves, in this order:
   - A **recent run that failed** (a status record inside the 45-minute warn
     window with `consecutive_failures` above 0) outranks everything: *the data
     cycle is running but failing every run for N runs since T (stage S):
     first error*. A failing run never signs off, so any sign-off still in the
     log predates the streak and is dropped from the alert.
   - **git failing to read history** (`git log` exiting non-zero) is named as
     *git cannot read the repository history (fatal: …)*, and the pipeline line
     says `last data commit UNREADABLE (git: …)`. It is never "unknown": a
     failed read is not an absence.
   - A **degraded sign-off** means a source is not refreshing, because the cycle
     plainly ran.
   - **Local output stale**: if a run finished inside the warn window and exited
     cleanly, *the data cycle is running and exiting cleanly … yet its local
     output is not refreshing*. Only when the status file is absent or its last
     run is older than that does it say the cron or its host is down.
   - Local output fresh but the commit not landing means the commit and push
     path broke; both current with a stale mirror means the publish path (deploy
     or Cloudflare) is at fault.

   The sign-off is `run-cycle.sh`'s `cycle_end()`, which is the single exit point
   for **four** messages, one per publishing path:

   | Sign-off | Reached the publish path? |
   | --- | --- |
   | `=== cycle complete ===` | yes: committed, pushed, deployed |
   | `=== no data changes vs HEAD; nothing to commit, skipping push/deploy ===` | no |
   | `=== no data files present to commit; skipping push/deploy ===` | no |
   | `=== DRY-RUN OK: … ===` | no (`--dry-run`) |

   A partial cycle signs any of them off as `=== MSG (DEGRADED) === refreshed: … |
   failed: … | skipped: …`. The monitor matches the banner shape rather than one
   message, excluding only `=== cycle start …`, which shares the shape and is not
   a verdict. The second form is what a broad upstream outage produces (the
   snapshot fetch fails, the derived generators skip, `git diff --quiet` finds
   nothing), so reading only `cycle complete` blamed exactly that outage on a dead
   cron. The alert says which of the two it is: *publishing what it can* when the
   cycle reached the publish path, *had nothing new to publish* when it did not.
4. **Alerts the ops chat** (`data/chat-outbox.json`) as one `action` entry,
   written with the same re-read plus atomic-rename swap every other writer uses,
   so a concurrent session reply is never clobbered. It never touches
   `data/.chat-cursor`.

Fail-safe and quiet by construction:

- **A fetch failure is not staleness.** Consecutive failures are counted; a lone
  transient error logs and exits 0. Only `RESPONDER_MONITOR_FAIL_STREAK`
  failures in a row (default 3, i.e. 45 min at the installed cadence) raise an
  `UNREACHABLE` alert.
- **Transition-gated with a cooldown, and escalation on top of it.** An alert
  posts when the verdict changes, or after the cooldown for its tier
  (`RESPONDER_MONITOR_COOLDOWN`, default 6h, for `WARN`;
  `RESPONDER_MONITOR_CRIT_COOLDOWN`, default 1h, for `CRITICAL` and
  `UNREACHABLE`), or as soon as the staleness reaches
  `RESPONDER_MONITOR_ESCALATE_FACTOR` times the age reported by the last alert
  (default 2x) regardless of cooldown. A repeat names how long the condition has
  gone uncleared. Recovery posts exactly one notice. The escalation exists
  because the monitor posts a recovery notice, which makes silence after an alert
  read as recovery: on 2026-07-29 one CRITICAL verdict held for 5h while the
  staleness went 95 to 305 min, and the flat gap kept all 20 checks silent.
- **No prior state is normal; a failed read is not.** A missing state file,
  outbox, cycle log or cycle status file, or a snapshot path with no commit yet,
  degrades to "unknown" (or is simply left out) and never fabricates an alert or
  crashes (upgrade path from any earlier version). A status file that exists but
  cannot be parsed is reported as `UNREADABLE`, and `git log` failing is
  reported as `UNREADABLE (git: …)`, because those are faults, not absences.
- Single-flight `flock` on `/tmp/responder-freshness-monitor.lock`; state in
  `/tmp/responder-freshness-state`
  (`verdict streak last_alert_epoch last_alert_age_min verdict_since_epoch`),
  where a reboot reset costs at most one extra alert. Shorter pre-upgrade lines
  are read with the missing columns at 0; a missing start column restarts that
  verdict's clock once. `tick-gate.sh` reads the start column (see "Tick gate").

Flags and tunables: `--dry-run` computes and logs the verdict, writing neither
the outbox nor the state file (use it to check the board by hand). Exit code is
`0` when fresh or deferring, `1` on any alerting verdict. Overrides:
`RESPONDER_MONITOR_URL`, `_WARN_MIN`, `_CRIT_MIN`, `_FAIL_STREAK`, `_COOLDOWN`,
`_CRIT_COOLDOWN`, `_ESCALATE_FACTOR`, `_TIMEOUT`, `_STATE`, `_LOCK`, `_LOG`,
`_OUTBOX`, `_SNAPSHOT`, plus
`RESPONDER_CYCLE_LOG` for the deploy-history read and `RESPONDER_CYCLE_STATUS`
for the last-run record (unset, it reads `/var/log/responder-cycle-status.json`,
or the `/tmp` fallback when that is absent). Log tees to
`/var/log/responder-freshness.log` (falls back to `/tmp`).

### Backup health rides along here

`backup.sh` writes `status.json` on every exit path and `restore-drill.sh` writes
`drill-status.json`, and for a long time **nothing read either file**. On
2026-08-25 the hourly backup began refusing (the root filesystem crossed its
2 GB free-space floor) and recorded `FAIL` every hour for three days while every
health signal the board had still read `OK`. The drill kept reporting `OK` too,
because it faithfully re-verified the last good bundle from the 25th.

This monitor is the only cron that already reaches the ops chat, so the backup
check lives here. Each run reads the newest manifest across all three tiers and
the last recorded backup verdict, and alerts when **either** the newest backup is
older than `RESPONDER_BACKUP_STALE_MIN` (default 360 min) **or** the last run
recorded `FAIL`. Both are needed: a refusing backup is caught the same hour by
the verdict, while a cron that stopped firing altogether leaves a healthy-looking
`OK` behind a manifest that quietly ages out. The alert quotes the `detail` the
backup itself recorded, so the message names the real cause rather than just the
symptom.

It keeps its own state file (`RESPONDER_BACKUP_STATE`, default
`/tmp/responder-backup-health-state`, holding
`verdict last_alert_epoch verdict_since_epoch`),
deliberately separate from the mirror state so neither condition can mask the
other, and it is transition-gated with its own cooldown
(`RESPONDER_BACKUP_COOLDOWN`, default 6h) and posts one recovery notice when it
clears. A host with no backup directory at `RESPONDER_BACKUP_DIR` is logged as
not checked rather than alerted, so a non-backup host is not a false alarm. An
alerting backup verdict sets exit `1` just as a mirror alert does.

### Operator runbook: what to do when it fires

Run `scripts/freshness-monitor.sh --dry-run` first to see the current verdict and
the three local ages, then act on the cause line it prints:

| Alert says | Do this |
| --- | --- |
| the data cycle is running but failing every run | The cron is fine; every run dies. The alert quotes the stage and the first error, and `/var/log/responder-cycle-status.json` holds the same record. For stage `materialize` the fault is git: run `git rev-parse HEAD` and `git fsck` in the repo. A branch ref emptied by a crash is repaired by pointing it back at the right commit (`git update-ref refs/heads/main <sha>`) only after confirming that commit against `git ls-remote origin main` and the reflog. Then run `scripts/run-cycle.sh` by hand and confirm the status file shows `consecutive_failures: 0`. |
| git cannot read the repository history | Same repair as a `materialize` failure above. This fires when the monitor has no recent cycle record to quote, so also check that the cron is still running. |
| the data cycle is running and exiting cleanly, yet its local output is not refreshing | A generator is reporting success without writing fresh data. `grep 'step: fetch-snapshot' -A5 /var/log/responder-cycle.log \| tail -20` and compare the snapshot's `generated` stamp with the run times. |
| the data cycle is not producing fresh local output | `tail -50 /var/log/responder-cycle.log`, confirm the cron is still installed (`crontab -l`), clear a stale `/tmp/responder-cycle.lock` if a run died holding it, then `scripts/run-cycle.sh` by hand. |
| the cycle is running and publishing what it can, but a source is not refreshing | The pipeline is healthy; one upstream is not. `grep 'WARN:\|SKIP:' /var/log/responder-cycle.log \| tail -20` names it. For an NWPS `429` this usually clears itself, so confirm nothing local is hammering the API (see "Browser verification" in `tests/README.md`) and let the next cycle retry. |
| the cycle is running but a source is not refreshing, so it had nothing new to publish | Same upstream story, one step worse: enough sources failed that no data file changed, so the cycle signed off without committing or deploying and the mirror is frozen at the last good publish. Still not the cron. `grep '=== ' /var/log/responder-cycle.log \| tail -5` shows the sign-off, `grep 'WARN:\|SKIP:' /var/log/responder-cycle.log \| tail -20` names the sources. If it persists past a few cycles the upstream outage is broad; check the source's own status page before touching anything local. |
| the commit and push path is not landing | Run `git status` and `git log --oneline -3` in the repo. Usually a push rejection (remote moved) or a dirty tree blocking the cycle: `git pull --rebase origin main`, then `scripts/run-cycle.sh`. |
| the publish path (deploy or Cloudflare) is serving stale data | Run `scripts/deploy.sh` by hand and read the pre-flight output. Most often the Cloudflare token is unreadable (see "Deploy token / ansible-vault") or wrangler failed. The data is already safe in git; the deploy is the only missing step. |
| UNREACHABLE | Check the site from another network before touching the pipeline. If respondertx.org is genuinely down, this is a Cloudflare or DNS problem, not a data problem, and the local pipeline needs no action. |
| Backup alert | Read the quoted `detail` first: it is what `backup.sh` itself recorded. A free-space refusal needs room on the backup volume (`df -h`, then reclaim), after which the next hourly run recovers on its own and posts a recovery notice. If instead the newest backup simply aged out with no `FAIL` recorded, the backup cron stopped firing: confirm with `crontab -l` and `tail -50 /var/log/responder-backup.log`. Nothing here blocks publishing, so it never needs a rushed fix during an event. |

Test coverage lives in `tests/freshness-monitor.test.sh` (fresh, stale, transient
failure, streak, cooldown, fresh-install, recovery, plus all four sign-off forms
degraded and clean, and a mid-run `cycle start` banner; then backup health:
healthy, a run that refused, a stale manifest behind an `OK` verdict, cooldown,
recovery, and an absent backup dir; then the cycle status file: failing, absent,
stale, clean-but-stale-output and unreadable; a git history that cannot be read;
and the verdict-start columns `tick-gate.sh` reads); it uses a `file://` mirror
URL and a throwaway backup dir, so it never touches the network or the real repo
data. `tests/run-cycle.test.sh` drives the real writer and reader together
against a scratch repo whose `refs/heads/main` is emptied the way the crash left it.

## Disaster recovery (`backup.sh`, `restore-drill.sh`, `hooks/pre-push`)

**Why this repository is not ordinary source.** `gen-history.py` rebuilds the playback
archive by walking git history: it `git show`s every past `data/gauges-capture.json` to
reconstruct observed gauge state. The commit history *is* the flood observation record, and
upstream keeps roughly 30 days, so history lost here is not re-fetchable. Treat the repo as
primary data, not as code with a copy on a build server.

**GitHub is a replica, not a backup.** `deploy.sh` pushes to `origin` (line ~283, before the
Cloudflare step, so a CF outage does not block the push). But a push faithfully replicates
whatever it is given: a bad commit, a truncated archive, a history rewrite. Replication
propagates destruction. Worse, the push only happens if every gate before it passes, so when
the tree is in the state most likely to need recovery, the offsite copy is also the most
likely to be stale. `backup.sh` reports the `origin` gap for exactly this reason.

### What runs

| When | What | Keeps |
|------|------|-------|
| `:47` hourly | `backup.sh --tier hourly` | 6 |
| `03:17` daily | `backup.sh --tier daily` | 7 |
| `04:37` Sunday | `backup.sh --tier weekly` | 4 |
| `03:51` daily | `restore-drill.sh` | verifies the newest snapshot |

Install with `install-cron.sh --backup`; the pre-push guard with `install-cron.sh --hooks`.

### What a snapshot contains

Written to `$RESPONDER_BACKUP_DIR` (default `/root/backups/responder`), **outside the repo**
so that deleting the repo does not delete its own backups:

- `mirror.git` — an incremental `--mirror` clone, refreshed each run, **never pruned**, and
  cloned `--no-hardlinks` so it does not share inodes with the repo it exists to survive.
  Never pruning is the point: a rewrite upstream leaves the old objects sitting here.
- `<tier>/repo-<stamp>.bundle` — a self-contained `git bundle --all`, restorable with a plain
  `git clone` on any machine, with no dependency on this host or on GitHub. Verified with
  `git bundle verify` before anything rotates out.
- `<tier>/state-<stamp>.tar.gz` — the state git does not track and therefore nothing else
  protects: `data/chat-inbox.jsonl`, `data/chat-outbox.json`, the chat cursors, and
  `.git/info/exclude`. The ops chat is the owner's message record and exists in one place.
- `<tier>/manifest-<stamp>.json` — HEAD, commit count, unpushed-to-origin gap, and the
  sha256 of each artifact. `status.json` records the outcome of the last run.

`backup.sh` refuses to run when free space is under `RESPONDER_BACKUP_MIN_FREE_MB` (2 GB
default) rather than filling the disk the board runs on, and every exit path writes
`status.json`. A backup that fails quietly is worse than none: the next incident would meet a
directory of stale bundles nobody knew had stopped.

### Restoring

```bash
git clone /root/backups/responder/<tier>/repo-<stamp>.bundle responder-restored
cd responder-restored && git log --oneline -3          # confirm the point in time
tar -xzf /root/backups/responder/<tier>/state-<stamp>.tar.gz   # chat + cursors, if needed
node --test tests/                                     # prove it works before trusting it
```

To recover a single bad commit without a full restore, the mirror still has the objects:
`git --git-dir=/root/backups/responder/mirror.git log --all --oneline | grep ...`, then
`git fetch /root/backups/responder/mirror.git <sha>`.

### Verifying (the part usually skipped)

Both scripts `cd` to the repo before doing anything. `git bundle verify` needs a repository to
resolve prerequisites against and answers "need a repository to verify a bundle" without one, so a
drill run from cron (CWD `$HOME`, not the repo) reported every healthy backup as rejected. It passed
by hand for a day before anyone read `drill-status.json`. `tests/backup.test.sh` now runs both from
a foreign CWD.

`restore-drill.sh` clones the newest bundle into a temp tree and checks the sha256 against the
manifest, `git bundle verify`, `git fsck`, HEAD and commit count against the manifest, that
**the oldest `gauges-capture.json` blob is still readable** (without it the archive cannot be
rebuilt, which is the thing actually being protected), that the state tar extracts, and that
the restored tree passes its own test suite. It writes `drill-status.json` and touches nothing
live. Mutation-tested against a flipped bundle byte and a manifest with the wrong HEAD.

### The guard

`hooks/pre-push` refuses non-fast-forward and branch-delete pushes to `main`. Everything else
is recoverable; a force push is the one operation that destroys the only offsite copy at the
same moment it destroys the local one. Override deliberately with
`RESPONDER_ALLOW_FORCE_PUSH=1`. Git never carries hooks, so **every fresh clone must run
`install-cron.sh --hooks`**.

### Known gap: this is 2 copies in 1 location

The snapshots live on the same host and the same filesystem as the repo. They survive a bad
commit, a bad push, an accidental delete and a corrupted working tree. They do **not** survive
losing this machine. GitHub is the offsite leg, but it is a replica on the same failure path.
Completing 3-2-1 needs an offsite target that a mistake here cannot reach: an R2/S3 bucket with
object-lock or versioning and write-only credentials, or a bare repo on another host. That is
an owner decision (it costs credentials and money) and is not wired up.

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
