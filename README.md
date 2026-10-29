# gladys-rainmachine

[Gladys Assistant](https://gladysassistant.com) external integration for
**RainMachine** sprinkler controllers through their local HTTPS API (port
8080, the password of the controller, the self-signed certificate pinned; the
RainMachine cloud is never used): zones watering and time remaining, programs
running, weather restrictions, water used (flow sensor, guarded); stops of a
zone, a program or everything held back by no option, read, command nor
pause; starting a zone behind an off-by-default option, its length bounded
1 to 60 minutes. **Never tested with a real device. Not affiliated with
RainMachine.**

User documentation: [docs/en.md](docs/en.md) · [docs/fr.md](docs/fr.md).

## How it works

```
Gladys ⇄ SDK ⇄ src/handlers.js ⇄ src/app.js (RainMachineApp)
                                  ├─ src/lane.js                 one exchange at a time (the stops first)
                                  ├─ src/rainmachine/client.js   login, token (memory only), statusCode
                                  ├─ src/rainmachine/http.js     the only network access (TLS, pinned, bounded)
                                  ├─ src/rainmachine/parse.js    the answers (strict, bounded)
                                  ├─ src/devices.js              devices and states (pure)
                                  ├─ src/guard.js                water counter guard (gladys-p1-monitor's)
                                  ├─ src/publisher.js            states within 300/min, nothing older than 2 min
                                  └─ src/store.js                /data/rainmachine-state.json (pins, stops, guard; no secret)
```

- **API** (regenmaschine 2024.3.0): `POST /api/4/auth/login` with the
  password gives an access token, sent as the `access_token` query parameter
  (memory only, renewed once on `statusCode` 2). Read: `provision/wifi` (the
  MAC, identity, first in every read), `zone` (the core);
  secondary, never blocking: `program`, `restrictions/currently`, `provision`
  (flow sensor), `provision/name`, `apiVer`. Written: `zone/<uid>/start`
  (`time` 60 to 3600 s), `zone/<uid>/stop`, `program/<uid>/stop`,
  `watering/stopall`. Nothing else.
- **TLS**: every exchange is its own connection; the SHA-256 fingerprint of
  the certificate is checked against the pin of the address before any byte
  leaves; the first pin is in `/data` before the password leaves; a new one
  is taken only by two clicks.
- **Reads**: every 60 s (15 s – 10 min), never sooner (button, scan,
  reconnection, restart) but the reads 5 and 20 s after a command; 429 and
  5xx pause (kept in `/data`); a refused password is never tried again
  automatically.
- **Devices**: `rainmachine:<mac>`, `rainmachine-zone:<mac>-<uid>`,
  `rainmachine-program:<mac>-<uid>`; buttons only, never a switch.
- **Stops**: never behind the option, a read, a command or a pause; kept in
  `/data` until seen applied, checked every 15 s, sent again 3 times at most
  once accepted, never let go by time nor before they left.

## Credits

Ported from [regenmaschine](https://github.com/bachya/regenmaschine) (Aaron
Bach, MIT, 2024.3.0); the meaning of the fields checked against the
`rainmachine` integration of Home Assistant. See
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). Modelled on the sibling
integrations [gladys-warp-charger](https://github.com/LM1LC3N7/gladys-warp-charger)
(stop, lane), [gladys-sma-ev-charger](https://github.com/LM1LC3N7/gladys-sma-ev-charger)
(pinned TLS) and [gladys-yardian](https://github.com/LM1LC3N7/gladys-yardian)
(sprinklers).

## Development

```bash
npm install
npm test                                        # node --test, no network but loopback
npm run lint && npm run format:check
npm run audit                                   # npm audit --omit=dev
npm run cover                                   # cover.png, plain Node
npx github:GladysAssistant/integration-store .  # store admission checks
```

The controller is a fake behind the injected exchange
(`test/helpers/fakeRainMachine.js`) on the virtual clock of the kit;
`test/http.test.js` runs the real transport and client against loopback TLS
servers, `test/realclock.test.js` the app on the real clock (×20).

## Releasing

**Actions → Release → Run workflow** (patch / minor / major): bumps the
version in `package.json` and the manifest, rolls `CHANGELOG.md`, tags, builds
the multi-arch image to GHCR and publishes the GitHub Release.

## License

Apache-2.0 (`LICENSE`). The ported logic comes from an MIT project, credited
in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) (also shipped in the
Docker image).
