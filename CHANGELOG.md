# Changelog

All notable changes to this integration are documented in this file. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project
uses [semantic versioning](https://semver.org/).

Describe each change under `## [Unreleased]` as you make it. The Release
workflow moves that section under the version it ships, and the section becomes
the notes of the version's GitHub Release.

## [Unreleased]

### Added

- RainMachine sprinkler controllers read over their local HTTPS API (port
  8080, the password of the controller, the certificate pinned at the first
  connection; the RainMachine cloud is never used): one device for the
  controller (keyed by its MAC address), one per active zone, one per program.
- Watering, rain delay, freeze protection, rain sensor and calendar
  restrictions (read only); zones watering and time remaining; programs
  running. The programs, restrictions, flow sensor, name and versions never
  hold the zones back.
- Water used (litres, from the flow sensor) behind a counter guard: never 0,
  drops and jumps held back (kept in `/data`, never confirmed by time) until
  "Accept the held water counter", in two clicks.
- Stops of a zone, of a program and of every zone, never held back (option,
  reads, a start in progress, pauses), kept in `/data` until seen applied,
  never given up before they left.
- Starting a zone behind "Allow watering" (off by default), for 1 to 60
  minutes, decided on a fresh read and confirmed by a read back.
- "Test the connection" and "Trust the new certificate" (two clicks).

### Changed

- Review r1: a hung /data never holds a read, a configuration nor a kept
  stop; "Stop all" is never let go by a start (starts are refused while it is
  kept); stops clicked together are all written first, then read back once;
  modern TLS first, the legacy handshake only for a controller that refuses it
  at its first connection (kept with the pin).
- Review r2: nothing pinned nor sent while /data is still being read;
  "Stop all" let go by two reads of every zone dry when the programs cannot
  be read; the TLS fallback only on a TLS alert.
