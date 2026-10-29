# RainMachine for Gladys

Shows your **RainMachine** sprinkler controller (Mini-8, Touch HD, Pro,
HD-12/16, first to third generation) in Gladys through its **local HTTPS
API**: no RainMachine cloud ("remote access" is not used), straight on your
network.

> **Never tested with a real device.** Not affiliated with RainMachine.
> The integration follows regenmaschine, the RainMachine library of Home
> Assistant, and its test captures. A firmware update may change the API.

## What you get

One device for the controller (keyed by its MAC address, not by its IP
address), one per **active** zone and one per program:

| Device     | Feature                                                                        | Content                                                                 |
| ---------- | ------------------------------------------------------------------------------ | ----------------------------------------------------------------------- |
| Controller | Watering                                                                       | Yes / no (a zone watering)                                              |
| Controller | Rain delay, freeze protection, rain sensor, hourly, month, weekday restriction | Yes / no (the weather restrictions in force; not on a first generation) |
| Controller | Water used (flow sensor)                                                       | In litres, the counter of the flow sensor, guarded (see below)          |
| Controller | Stop all watering                                                              | Button, **always available**                                            |
| Zone       | Watering                                                                       | Yes / no (a zone queued behind another one is "no" until it starts)     |
| Zone       | Time remaining                                                                 | In minutes                                                              |
| Zone       | Start watering                                                                 | Button (only with "Allow watering")                                     |
| Zone       | Stop watering                                                                  | Button, **always available**                                            |
| Program    | Running                                                                        | Yes / no                                                                |
| Program    | Stop the program                                                               | Button, **always available**                                            |

Gladys never starts a program: a program waters for as long as the
controller computes (weather, seasonal adjustment), which Gladys cannot
bound. Read every 60 seconds by default (15 s to 10 min), one request at a
time. The programs, the restrictions, the flow sensor, the name and the
versions are secondary: when one does not answer, the other values are
published anyway and the status says "Not read this time: ...".

## Installation

1. Give the controller a fixed IP address in your router.
2. In Gladys, install the integration, enter the IP address of the controller
   (optionally followed by a port, 8080 by default) and its **password** (the
   one the RainMachine app asks for).
3. Save, then add the devices from the **Discovery** tab.

The password is kept by Gladys in its database, never shown again, sent only
to the controller, in the body of the login. The access token the controller
gives back is kept in memory only (never on disk), and sent with each request
as the API wants it. The controller serves a **self-signed certificate**: it is
**pinned** at the first connection (its SHA-256 fingerprint kept in `/data`
before the password leaves). If it changes later (controller reset or
replaced), nothing is sent to it, the status shows the new fingerprint, and
the **Trust the new certificate** button takes it in two clicks (3 s to
5 min apart). A first generation controller only speaks old TLS: the
integration accepts it, the pin vouches for the controller.

A refused password is **not tried again automatically**: save the right one,
or click **Test the connection** (one try a minute at most).

## The stops

**Stop watering** (a zone), **Stop the program** and **Stop all watering**
(`watering/stopall`) do not depend on "Allow watering", on a read or a start
in progress (they end them), on a pause after a 429 or 5xx error, nor on a
read that failed. A start that arrived before a stop and has not left is
dropped.

A stop succeeds when the read back shows the zone (the program, every zone
and program) not watering. Otherwise the answer says why, and the stop is
kept in `/data` and checked every 15 s. It does not leave at once, and is
kept until it can, only in these cases (the status of the integration says
which):

- **the controller does not answer**: tried again every 250 ms for 3 s, then
  every 15 s, with no time limit;
- **the password is not known yet**: right after a restart, before Gladys
  gives the configuration (the password is never written to `/data`): sent as
  soon as it does;
- **the password is refused**: the click tries one login (one a minute at
  most); then sent as soon as the right password is saved or **Test the
  connection** logs in;
- **the certificate changed**: sent as soon as it is trusted, or the pinned
  one is back;
- **`/data` cannot be read** (the pin is unknown) or the first pin cannot be
  saved: nothing is sent, tried again every 15 s.

It is refused unsent only when no address of a controller is known at all,
or when the last read showed another controller (another MAC address) at
that address.

A stop sent but **not applied** (the zone still waters) is sent again by the
checks, 3 times at most once the controller accepted it, then kept without
new writes and said in the status until a new click. Only a write the
controller accepted counts as a try: a stop that never left is never given
up. A kept stop is let go when a read shows it applied, or when a start of
that zone clicked in Gladys afterwards left (that start is the newer wish),
or when a read shows another controller (another MAC address) at its address.
Never by time. A start sent less than 90 s before the stop that lands after
it is countered. Once a stop is seen applied, a zone started from the
RainMachine app is not countered.

## Start watering (option)

Off by default: turn on **Allow watering**. It is a button, never a switch (a
"turn everything off" never reaches a valve). Each start reads the controller
right before (identity, zones), leaves within 3.5 s or not at all, and waters
for the configured length (**1 to 60 minutes**, 10 by default, bounded again
before the write): the controller closes the valve by itself at the end. It
succeeds only when the read back shows the zone watering; "queued" when the
controller queued it behind another zone, "sent, not applied yet" or "sent,
without confirmation" otherwise (then reads at 5 and 20 s).

A scene starting several zones at once: one read for all of them, then one
write each, one at a time; on a slow controller, a start that cannot leave
within 3.5 s of its click is refused, nothing sent.

Also refused: an inactive zone, a zone the controller no longer has, another
controller at the address, during a 429/5xx pause, with a refused password,
before the configuration is read, or while a stop is on its way.

## Water used (guarded)

When a flow sensor is set in the controller, **Water used** is its counter in
litres (its clicks divided by its clicks per cubic metre; the RainMachine app
shows gallons with US units, the API gives cubic metres). As a lifetime
counter, it goes through a **guard**:

- 0 or missing is not published;
- a plausible rise (100 litres a minute on average at most) goes through;
- a **drop** (flow sensor reset, controller replaced) or a **jump** is
  **held**: the last value stays, the status shows it, the hold is kept in
  `/data`. Neither time nor repetition confirms it;
- the **Accept the held water counter** button takes it in **two clicks**:
  the first shows the value, the second (3 s to 5 min later) takes exactly
  that value (plus what may have flowed since).

## Good to know

- The controller is not read sooner than the interval: not by **Test the
  connection**, a Discovery, a reconnection to Gladys nor a restart (the time
  of the last read is kept in `/data`). Only the reads that follow a command
  (5 and 20 s) are an exception.
- A value older than 2 minutes is not sent as new.
- Nothing secret is written to `/data` nor to the logs.
- The RainMachine app, its schedules and the weather may change the zones too:
  the last one wins.
