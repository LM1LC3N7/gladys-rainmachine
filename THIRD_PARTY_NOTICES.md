# Third-party notices

This integration is licensed under the Apache License 2.0 (see `LICENSE`).

## regenmaschine

The RainMachine local API client (`src/rainmachine/client.js`,
`src/rainmachine/parse.js`, `src/constants.js`) ports parts of
**regenmaschine** 2024.3.0 (<https://github.com/bachya/regenmaschine>, read at
commit `1c530f7` of 2024-11-12), a Python client of the RainMachine API used
by Home Assistant, to JavaScript: the login with `pwd` and `remember`, the
access token sent as the `access_token` query parameter, the `statusCode`
errors (2 not authenticated, 13 unknown call), the paths of the zones, the
programs, the restrictions, the provision, the start and stop commands with
their ids repeated in the body for the first generation, the loosened TLS of
the first generation. Its test fixtures shaped the fake controller of the
tests. No Python code runs here and regenmaschine is not a dependency. This
port was modified: written in JavaScript, every request bounded in time and
size, the certificate pinned, one request at a time, no cloud, no program
start, no firmware update, no setting written.

Its license:

```
The MIT License (MIT)

Copyright (c) 2017-2024 Aaron Bach

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## Home Assistant `rainmachine` integration

The meaning of the fields (run states 0, 1, 2; the litres of the flow sensor
from its clicks and its clicks per cubic metre; the restrictions read) was
checked against the `rainmachine` integration of Home Assistant
(<https://github.com/home-assistant/core>, `homeassistant/components/rainmachine`,
Apache License 2.0, Copyright the Home Assistant authors). Nothing of its
code is copied.

## gladys-warp-charger, gladys-sma-ev-charger, gladys-p1-monitor

`src/lane.js`, `src/publisher.js` and `src/guard.js` are taken from
gladys-warp-charger (itself taking its guard from gladys-p1-monitor), and
`src/rainmachine/http.js` from gladys-sma-ev-charger, by the same author,
under the same Apache License 2.0.

## gladys-testkit

`test/kit/` holds files of gladys-testkit (commit `f8f5301`), Apache License
2.0, by the same author: fake servers, clocks and the test certificates
(test keys only, never used outside the tests).
