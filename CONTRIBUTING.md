# Contributing to ResponderTX

Thanks for helping improve the board. Corrections to data, new keyless data
sources, accessibility fixes, and field-tested UX improvements are all welcome.

## How to contribute

- **Bug reports & data corrections:** open a [GitHub issue](https://github.com/rfxn/responder-tx/issues)
  with what you saw, the view (a shared `?`-link is ideal), and the expected result.
- **New data source:** it must be **keyless** (the board has no backend to hold
  credentials) and either CORS-open or servable through the existing same-origin
  `/api/cam` style proxy. Include the endpoint, the attribution terms, whether it
  publishes a capture time, and how it should age. A feed that publishes no capture
  time cannot age honestly, which is a blocker unless the currency claim can be
  stated some other way.
- **Feature ideas:** open an issue describing the field problem first. The board
  optimizes for a responder making a decision in under ten seconds.

## Non-negotiables

Any change must preserve the invariants the board is built on:

- **Stale never shows as live.** New layers ship with a staleness threshold,
  auto-suppression, and a retrievable history view. Suppress &#8800; delete.
- **Forecast is labeled distinctly from observed.**
- **Every card cites its source**, and timestamps come from the wall clock.
- **No accounts, no analytics, no third-party trackers.** The board core stays
  zero-backend; the only server-side state is the two opt-in relays, and each stays
  dormant until a user turns it on.
- **English and Spanish stay at parity.** Every new i18n key ships in both tables.
- **The 911 / not-a-dispatch-system disclaimer stays pinned** and consistent.
- **Public-mirror hygiene:** nothing LAN-only (chat, operator inboxes, repo
  internals) may leak into the public deploy.

## Development

No build step. Clone and serve:

```bash
git clone https://github.com/rfxn/responder-tx.git
cd responder-tx
python3 server.py     # https://localhost:8443 with a cert, else http://localhost:8080
```

Before opening a PR, run the tests and the pre-commit sanity bundle:

```bash
bash tests/run.sh        # node, shell and python suites; log captured, failures named
scripts/cycle-check.sh   # eleven checks: JSON, JS syntax, version agreement, feeds,
                         # snapshot, staged files, the 911 gates, schemas, cursors
```

A release also moves `APP_VERSION` in `js/core.js`, `SW_VERSION` in `sw.js`, every
`?v=` asset stamp in `index.html`, `CHANGELOG.md` and `data/changelog.json`
together; `cycle-check.sh` fails if they disagree.

Match the existing vanilla-JS style in `js/` (focused modules, shared `state` /
`CONFIG` from `core.js`, no framework). See [ARCHITECTURE.md](ARCHITECTURE.md) for
the module map.

## License

By contributing, you agree that your contributions are licensed under the
**GNU GPL v2**.

---

> Copyright (C) 2026 R-fx Networks &lt;proj@rfxn.com&gt; &#183; Ryan MacDonald &#183; Licensed under GNU GPL v2
