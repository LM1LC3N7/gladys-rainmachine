# CLAUDE.md

Project rules for coding assistants (Claude Code reads this file) and for
human contributors.

## What this is

A Gladys Assistant **external integration** of type `device`: a Node.js
service (Node 22+, ESM, no build step) in its own sandboxed Docker container,
talking to Gladys through `@gladysassistant/integration-sdk` (v0.16). It reads
a **RainMachine** sprinkler controller over its local HTTPS API (port 8080,
the password of the controller, an access token in memory, the self-signed
certificate pinned) and exposes the controller, its active zones and its
programs as Gladys devices, with stop buttons and an optional start. Unofficial:
not affiliated with RainMachine. Ported from regenmaschine 2024.3.0 (MIT), see
THIRD_PARTY_NOTICES.md.

## Commands

```bash
npm install
npm test                                  # node --test --test-timeout=60000
npm run lint                              # ESLint
npm run format:check                      # Prettier, as the CI runs it
npm run audit                             # npm audit --omit=dev
npm run cover                             # regenerates cover.png (800×534)
npx github:GladysAssistant/integration-store .   # store admission checks
```

On the maintainer's VM: `gi test`, `gi ci`.

## Architecture

See README.md ("How it works") and the header of each file in `src/`.

## Rules

- **Unofficial.** Every user-facing surface says it. Never the RainMachine logo.
- **Keys are forever**: manifest keys (`host`, `password`, `allow_watering`,
  `watering_minutes`, `poll_interval`, `language`, the actions
  `test_connection`, `trust_certificate`, `accept_held_counter`), external id
  types, the identity rule (the MAC), feature keys (`src/constants.js`).
- **Secrets**: the password only in the login body, the token only in the
  query string of a request over the pinned TLS; neither in a log, an error,
  a status nor /data. A `secret` field is "kept by Gladys in its database,
  never shown again", never "encrypted".
- **TLS**: nothing written before the certificate matches the pin; the first
  pin in /data before the password leaves; never learnt again without two
  clicks.
- **Starting a zone opens a valve**: off by default, never a switch, decided
  on a fresh read, option checked again in `beforeSend`, length bounded 1 to
  60 minutes before the write. **The stops are never held back** by the
  option, a pause, a read or a start; the cases where one does not leave at
  once are listed in the docs and in the header of `src/app.js`, and must
  stay documented exactly. A stop that never left is never given up.
- **Never read sooner than the interval** (restart included); 429/5xx are
  persisted; a refused password is never retried automatically.
- **Paths from regenmaschine only** (`PATHS` in `src/constants.js`).
- **Read-only rootfs**: write nothing outside /data.
- **Versions belong to the Release workflow** (Actions → Release). Never edit
  `version` by hand (0.1.0 was set by hand once, see TODO.md).
- **Changelog**: every user-visible change adds a line under `## [Unreleased]`.
- **User-facing text** is bilingual, `docs/en.md` and `docs/fr.md` in sync.
- **Tests never touch the network** but loopback servers (`test/http.test.js`).

## CI and pushes

- Group the commits and push **at most once a day**, unless the maintainer
  explicitly asks otherwise: the GitHub Actions quota is limited.
