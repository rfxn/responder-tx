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
| `fetch-snapshot.py` | Fetch the NWPS bbox gauge set → `data/gauges-snapshot.json` (compact `{generated, gauges:[{lid,name,latitude,longitude,status}]}`). Aborts non-zero on HTTP error or a `<200`-gauge response so a bad fetch never overwrites a good snapshot; writes atomically (temp file + rename). |
| `gen-roads-snapshot.py` | Archive the DriveTexas road-closure set → `data/roads-snapshot.json` (best-effort; keeps prior file on fetch failure). |
| `gen-history.py` | Walk the committed `gauges-snapshot.json` history + USGS/NWPS backfill → `data/history.json` (playback timeline). |
| `gen-crest-summary.py` | Per-gauge event peak stages for AAR/FEMA → `data/crest-summary.json`. |
| `gen-feeds.py` | RSS `feed.xml` + `crests.ics` from the current snapshot + requests + live NWS FF alerts. |
| `cycle-check.sh` | Pre-commit validation bundle (JSON validity, JS syntax, version agreement, feed freshness, snapshot sanity, staged-file guard). |
| `deploy.sh` | Version-agreement pre-flight → `git push` → build stripped archive (drops `js/chat.js`, empty chat-outbox) → `wrangler pages deploy` → live smoke. |
| `run-cycle.sh` | **The durable cycle runner** — orchestrates all of the above. |
| `chat-poll.sh` | **The durable ops-chat processor** — instant auto-ack + tightly-scoped headless `claude -p`. |
| `install-cron.sh` | Idempotent installer/uninstaller for the data-cycle **and** chat-poll system-cron entries. |

`gen-cameras.py` is a separate poller and is **not** part of the 15-min cycle.

## The cycle (`run-cycle.sh`)

Order (matches the manual per-cycle protocol):

1. `fetch-snapshot.py` → fresh `data/gauges-snapshot.json`
2. `gen-roads-snapshot.py` → `data/roads-snapshot.json`
3. `gen-history.py` → `data/history.json` (reads *committed* snapshot history; the newest frame lands next cycle — existing behavior)
4. `gen-crest-summary.py` → `data/crest-summary.json`
5. `gen-feeds.py` → `feed.xml` + `crests.ics`
6. `cycle-check.sh` → validate
7. If any of the six data files differ from `HEAD`: `git add` them **by name**, commit (author `Ryan MacDonald <ryan@rfxn.com>`, message `Data refresh <UTC> (auto-cron): snapshot N gauges + roads/history/crest/feeds regen`), `git push origin main`, then `deploy.sh`.

Properties:

- **`--dry-run`** runs steps 1-6 and stops before any git/deploy — used to verify the pipeline composes.
- **Idempotent / no empty commits** — if no data file changed vs `HEAD`, it skips commit/push/deploy.
- **Fail-safe** — a failed fetch (or any generator/validation failure) aborts the cycle before commit, leaving the last-good published state intact. If `deploy.sh` fails *after* commit+push, the data is already durable in git/GitHub and the next cycle redeploys.
- `set -euo pipefail`; every `cd` is guarded.

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
2. **Headless `claude -p` processing.** The script then invokes the `claude` CLI
   in headless print mode with the fixed, trusted chat-poll protocol prompt. The
   LLM reads the new inbox lines and appends its replies
   (`{"ts","role":"claude","text"}`, plus optional `role:"action"` notes) to
   `data/chat-outbox.json`. The **wrapper** — not the LLM — advances
   `data/.chat-cursor` after validating the outbox is still valid JSON. On any
   failure the cursor is left unadvanced (next run retries) and the outbox is
   restored from a pre-call backup; the owner already got the auto-ack.

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
timeout 180 claude -p "<fixed trusted protocol prompt>" \
  --allowedTools "Read Edit Write" \
  --disallowedTools "Bash WebFetch WebSearch Task" \
  --output-format text
```

- **No `--dangerously-skip-permissions` / no `bypassPermissions`.** `--permission-mode`
  is intentionally omitted (the CLI has no `default` choice; the plain headless
  mode is used). In headless print mode, any tool not pre-approved via
  `--allowedTools` is denied — there is no interactive prompt to accept it — so
  the allowlist is effectively a strict allow-only set.
- **Only file tools, no shell/network.** `Read/Edit/Write` are all the LLM needs
  to read the inbox and append to the outbox. `Bash` is **explicitly denied** —
  this removes arbitrary shell/RCE, which is the highest-impact prompt-injection
  outcome. `WebFetch`/`WebSearch`/`Task` are denied to block data-exfil/SSRF and
  spawning unscoped subagents.
- **Cursor + JSON validation are done by the trusted wrapper**, not the LLM, so
  the prompt tells the LLM *not* to touch `data/.chat-cursor` — it needs no
  write access to the cursor at all.
- **Fixed trusted prompt.** The protocol prompt is built by the script (not
  taken from the inbox) and explicitly instructs the LLM to treat message text
  strictly as data and to refuse embedded instructions that would change its
  rules, tools, or touched files, or ask it to run commands / deploy / edit app
  source.

**Residual risk (documented, accepted):** an autonomous scheduled LLM still
processes attacker-influenceable text with `Read/Edit/Write`. Because `Bash` and
network tools are denied, the worst a successful injection can do is write junk
into repo files it can reach; it **cannot** execute shell, reach the network,
push, or deploy. The public mirror strips the chat surface entirely (`deploy.sh`
drops `js/chat.js` and ships an empty outbox), and `cycle-check.sh` re-validates
before any commit. **Tighter still (controller may adopt after a live test):**
path-scope the file tools, e.g.
`--allowedTools "Read(data/**) Edit(data/chat-outbox.json) Write(data/chat-outbox.json)"`,
so even a compromised run can only touch the outbox. This variant is not the
default only because it could not be fired live here (doing so would incur cost
and double-process real messages); validate the rule syntax with one live run,
then switch the cron line to it.

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
  `RESPONDER_CHAT_LOCK`, `RESPONDER_CHAT_LOG`, `RESPONDER_CHAT_ACK_CURSOR`.

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

## Cron schedule & install

`install-cron.sh` manages two independent system-cron entries. The default
target is the **data-refresh cycle** (`8,23,38,53 * * * *`); `--chat` /
`--chat-ack-only` manage the **chat-inbox poll** (`*/3 * * * *`). Each target is
grep-guarded on its own command path, so managing one leaves the other intact.

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
```

Installed crontab entries (marker comment on its own line above each):

```
# responder-tx durable data-refresh cycle (managed by install-cron.sh)
8,23,38,53 * * * * /root/admin/work/proj/responder/scripts/run-cycle.sh >/dev/null 2>&1
# responder-tx durable chat-inbox poll (managed by install-cron.sh)
*/3 * * * * /root/admin/work/proj/responder/scripts/chat-poll.sh >/dev/null 2>&1
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
