# Contributing to Responder TX

Thanks for helping improve the board. Corrections to data, new keyless data
sources, accessibility fixes, and field-tested UX improvements are all welcome.

## How to contribute

- **Bug reports & data corrections:** open a [GitHub issue](https://github.com/rfxn/responder-tx/issues)
  with what you saw, the view (a shared `?`-link is ideal), and the expected result.
- **New data source:** it must be **keyless and CORS-open** (the board has no
  backend to hold credentials). Include the endpoint, the license/attribution
  terms, and how it should age.
- **Feature ideas:** open an issue describing the field problem first — the board
  optimizes for a responder making a decision in under ten seconds.

## Non-negotiables

Any change must preserve the invariants the board is built on:

- **Stale never shows as live.** New layers ship with a staleness threshold,
  auto-suppression, and a retrievable history view. Suppress &#8800; delete.
- **Forecast is labeled distinctly from observed.**
- **Every card cites its source**, and timestamps come from the wall clock.
- **No accounts, no analytics, no third-party trackers.** Keep it zero-backend.
- **The 911 / not-a-dispatch-system disclaimer stays pinned** and consistent.
- **Public-mirror hygiene:** nothing LAN-only (chat, operator inboxes, repo
  internals) may leak into the public deploy.

## Development

No build step. Clone and serve:

```bash
git clone https://github.com/rfxn/responder-tx.git
cd responder-tx
python3 server.py     # http://localhost:8080
```

Before opening a PR, run the pre-commit sanity bundle:

```bash
scripts/cycle-check.sh   # JSON validity, JS syntax, version agreement
```

Match the existing vanilla-JS style in `js/` (focused modules, shared `state` /
`CONFIG` from `core.js`, no framework). See [ARCHITECTURE.md](ARCHITECTURE.md) for
the module map.

## License

By contributing, you agree that your contributions are licensed under the
**GNU GPL v2**.

---

> Copyright (C) 2026 R-fx Networks &lt;proj@rfxn.com&gt; &#183; Ryan MacDonald &#183; Licensed under GNU GPL v2
