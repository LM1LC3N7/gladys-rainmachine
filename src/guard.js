// -----------------------------------------------------------------------------
// Plausibility of the water counter of the controller (litres counted by its
// flow sensor), a lifetime counter. Pure.
//
// A counter never goes down on its own: a drop is a reset of the flow sensor
// count, a replaced controller, or a bad read; a jump far above what a garden
// can draw is a bad read or a calibration changed. The rules:
// - a value of 0 (or below) is never published;
// - a value plausible after the last one published (not lower, not more than
//   COUNTER_MAX_PER_HOUR on average since then, plus COUNTER_SLACK) goes
//   through; a value EQUAL to it goes through without moving its date, so
//   that a frozen reading never shrinks the margin of the next real rise;
// - a drop and a jump up are NEVER confirmed by repetition nor by time: they
//   are held (the last accepted value is sent again), shown in the status,
//   kept in /data across restarts, and taken only on an explicit gesture of
//   the user (`acceptHeld`, the "Accept the held water counter" action, two
//   clicks): that is the way out of a reset or a replacement;
// - the acceptance is BOUNDED: it covers the value shown (`held.to`, read at
//   `held.at`) and what may have flowed since (the margin), nothing else; a
//   value outside the bounds is held again and the acceptance dropped; a drop
//   accepted is the new floor;
// - while a jump is held, every value at or above it stays held: the margin
//   growing while nothing is published must never cover it;
// - a value back to the usual rule (the drop or the jump was a glitch) ends
//   the hold, but only within the margin counted from the hold itself.
//
// Taken from gladys-warp-charger (src/guard.js, itself gladys-p1-monitor's,
// approved), with the litres of a garden instead of the kWh of a charger. Its
// times are those of the app's session clock (src/app.js).
// -----------------------------------------------------------------------------

import { COUNTER_MAX_PER_HOUR, COUNTER_SLACK } from './constants.js';

const HOUR = 3_600_000;

/** Litres that may flow between `from` and `to` (ms): the margin of the guard. */
export const margin = (from, to) =>
  (COUNTER_MAX_PER_HOUR * Math.max(0, to - from)) / HOUR + COUNTER_SLACK;

/** Whether `value` may follow `previous` (both `{ value, at }`). */
function follows(previous, value, at) {
  return value >= previous.value && value - previous.value <= margin(previous.at, at);
}

const validLast = (last) =>
  last && Number.isFinite(last.value) && last.value > 0 && Number.isFinite(last.at)
    ? { value: last.value, at: last.at }
    : undefined;

const validHeld = (held) =>
  held &&
  (held.direction === 'up' || held.direction === 'down') &&
  [held.from, held.to, held.threshold, held.at].every(Number.isFinite)
    ? {
        direction: held.direction,
        from: held.from,
        to: held.to,
        threshold: held.threshold,
        at: held.at,
      }
    : undefined;

export class CounterGuard {
  /**
   * `last`: the value Gladys already holds (`{ value, at }`), when known.
   * `saved`: the state kept in /data (`state()`), so that a value held back
   * stays held across a restart. `loadedAt`: when it is loaded; a value held
   * read back from /data is dated then (its old date would widen the range
   * an acceptance takes).
   */
  constructor(last, saved, loadedAt) {
    const kept = validLast(saved?.last);
    const known = validLast(last);
    if (kept && known && kept.value === known.value) {
      // The same value: its OLDEST date, the margin of the next rise counts from it.
      this.last = { value: kept.value, at: Math.min(kept.at, known.at) };
    } else {
      // Otherwise the most recent reference wins.
      this.last = kept && (!known || kept.at >= known.at) ? kept : known;
    }
    /**
     * A value held back until the user accepts it:
     * `{ direction: 'up' | 'down', from, to, threshold, at }`, `to` the last
     * value held, read at `at`. For a jump up, every value at or above
     * `threshold` stays held whatever the time.
     */
    const keptHeld = this.last ? validHeld(saved?.held) : undefined;
    this.held = keptHeld && Number.isFinite(loadedAt) ? { ...keptHeld, at: loadedAt } : keptHeld;
    /** The acceptance of the user: `{ direction, to, at }`, the value shown then. */
    this.accepted = undefined;
  }

  /** What /data keeps: the reference and the value held (never an acceptance). */
  state() {
    return { last: this.last ?? null, held: this.held ?? null };
  }

  /**
   * The user accepts the value held, as shown now. Returns what will be
   * counted (`{ direction, from, to }`), or undefined when nothing is held.
   */
  acceptHeld() {
    if (!this.held) {
      return undefined;
    }
    const { direction, from, to, at } = this.held;
    this.accepted = { direction, to, at };
    return { direction, from, to };
  }

  /** Whether `value` is within the acceptance: the value shown, plus the margin since. */
  withinAccepted(value, at) {
    const { to, at: since } = this.accepted;
    const top = to + margin(since, at);
    // Both ways bounded below too: a drop accepted is the new floor (as gladys-resol).
    return value >= to && value <= top;
  }

  /** Whether `value`, read at `at`, may be published. A published value becomes the reference. */
  accept(value, at) {
    if (!Number.isFinite(value) || value <= 0) {
      return false;
    }
    if (!this.last) {
      return this.take(value, at);
    }
    if (value === this.last.value) {
      // Unchanged (a frozen reading): published, its date NOT moved.
      this.release();
      return true;
    }
    if (this.accepted) {
      if (this.withinAccepted(value, at)) {
        return this.take(value, at);
      }
      // Not what the user accepted: held again, the acceptance dropped.
      this.accepted = undefined;
    }
    const up = this.held?.direction === 'up';
    if (up && value >= this.held.threshold) {
      // Held, however long ago the last value was published.
      this.held = { ...this.held, to: value, at };
      return false;
    }
    // While a value is held, the margin since the reference (maybe days old)
    // is not enough: the value must also fit the short margin counted from
    // the hold. Otherwise it becomes the value held itself, its litres shown,
    // nothing counted without the user.
    const sinceHold = !this.held || value - this.last.value <= margin(this.held.at, at);
    if (sinceHold && follows(this.last, value, at)) {
      return this.take(value, at);
    }
    const direction = value > this.last.value ? 'up' : 'down';
    this.held = {
      direction,
      from: this.last.value,
      to: value,
      threshold: direction === 'up' && up ? Math.min(value, this.held.threshold) : value,
      at,
    };
    return false;
  }

  release() {
    this.held = undefined;
    this.accepted = undefined;
  }

  take(value, at) {
    this.last = { value, at };
    this.release();
    return true;
  }
}
