# Responder data pipeline — scripts & cron reference

Low-weight, locally-runnable data pipeline for the Responder flood ops board.
Composes plain `bash` + `python3` + system `cron` — no cloud workers, no new
services. Its purpose is durability: the 15-minute public data refresh runs
from **system cron**, so it no longer depends on a live Claude session being
open (a session gap previously let the public board go ~151 min stale).

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
| `install-cron.sh` | Idempotent installer/uninstaller for the system-cron entry. |

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

## Cron schedule & install

The cron runs at **`8,23,38,53 * * * *`** (the existing 15-min slots).

```bash
# install (idempotent — safe to re-run; never duplicates the line)
/root/admin/work/proj/responder/scripts/install-cron.sh

# preview without touching the live crontab
/root/admin/work/proj/responder/scripts/install-cron.sh --dry-run

# remove
/root/admin/work/proj/responder/scripts/install-cron.sh --remove
```

Installed crontab entry (marker comment on its own line above it):

```
# responder-tx durable data-refresh cycle (managed by install-cron.sh)
8,23,38,53 * * * * /root/admin/work/proj/responder/scripts/run-cycle.sh >/dev/null 2>&1
```

The installer greps the crontab for the command path and strips any prior
managed lines before re-adding, so re-running is a no-op on the entry count.

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

System cron is the **primary** data-refresh driver. Once
`install-cron.sh` is active, the session-only Claude crons are **redundant for
data refresh** and should be disabled to avoid double-commits — both paths write
the same six files and push to the same branch. Keep session tooling for
human-in-the-loop work (news sweeps, `requests.json`/`resources.json` curation,
app releases); leave the mechanical 15-min data refresh to system cron.
