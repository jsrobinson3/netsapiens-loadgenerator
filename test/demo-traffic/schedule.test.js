const { isBusinessHours, interArrivalMs, scaledMs } = require('../../demo-traffic/lib/schedule');
const { SimClock } = require('../../lib/agent-sim/time');
const { freshLab, makeRng } = require('./helpers');

// lab.json: Mon-Fri 08:00-18:00 America/New_York. In late October (EDT) that is UTC-4.
const lab = freshLab();
const at = iso => Date.parse(iso);

describe('isBusinessHours', () => {
  test('inside the window on a weekday', () => {
    expect(isBusinessHours(at('2026-10-26T14:00:00Z'), lab)).toBe(true); // Mon 10:00 EDT
  });

  test('window start is inclusive and end is exclusive', () => {
    expect(isBusinessHours(at('2026-10-26T12:00:00Z'), lab)).toBe(true);  // 08:00
    expect(isBusinessHours(at('2026-10-26T11:59:00Z'), lab)).toBe(false); // 07:59
    expect(isBusinessHours(at('2026-10-26T21:59:00Z'), lab)).toBe(true);  // 17:59
    expect(isBusinessHours(at('2026-10-26T22:00:00Z'), lab)).toBe(false); // 18:00
  });

  test('closed at the weekend', () => {
    expect(isBusinessHours(at('2026-10-24T15:00:00Z'), lab)).toBe(false); // Sat
    expect(isBusinessHours(at('2026-10-25T15:00:00Z'), lab)).toBe(false); // Sun
  });

  test('uses the lab time zone, not UTC', () => {
    // 02:00 UTC Tuesday is Monday 22:00 in New York.
    expect(isBusinessHours(at('2026-10-27T02:00:00Z'), lab)).toBe(false);
  });

  test('a compressed clock walks through the window', () => {
    // 2026-10-26 07:00 EDT with time-scale 3600: one real second = one simulated hour.
    const clock = new SimClock(3600, at('2026-10-26T11:00:00Z'));
    expect(isBusinessHours(clock.now(), lab)).toBe(false);
    clock.realStart -= 1500; // pretend 1.5 real seconds passed => 08:30 simulated
    expect(isBusinessHours(clock.now(), lab)).toBe(true);
  });
});

describe('interArrivalMs', () => {
  const mean = 3600000 / 6;

  test('is deterministic for a seed', () => {
    const a = interArrivalMs(makeRng('x'), 6);
    const b = interArrivalMs(makeRng('x'), 6);
    expect(a).toBe(b);
  });

  test('is jittered and clamped to [0.15, 4] x mean', () => {
    const rng = makeRng('jitter');
    const draws = Array.from({ length: 500 }, () => interArrivalMs(rng, 6));
    expect(new Set(draws).size).toBeGreaterThan(400);
    for (const d of draws) {
      expect(d).toBeGreaterThanOrEqual(mean * 0.15 - 1e-6);
      expect(d).toBeLessThanOrEqual(mean * 4 + 1e-6);
    }
  });

  test('averages near the configured rate', () => {
    const rng = makeRng('avg');
    const draws = Array.from({ length: 4000 }, () => interArrivalMs(rng, 6));
    const avg = draws.reduce((s, v) => s + v, 0) / draws.length;
    expect(avg).toBeGreaterThan(mean * 0.8);
    expect(avg).toBeLessThan(mean * 1.2);
  });

  test('time-scale N divides the wait by N', () => {
    expect(interArrivalMs(makeRng('s'), 6, 60)).toBeCloseTo(interArrivalMs(makeRng('s'), 6, 1) / 60, 6);
  });

  test('a zero or negative rate never fires', () => {
    expect(interArrivalMs(makeRng('z'), 0)).toBe(Infinity);
    expect(interArrivalMs(makeRng('z'), -1)).toBe(Infinity);
  });

  test('honours custom clamp factors', () => {
    const rng = makeRng('clamp');
    for (let i = 0; i < 100; i++) {
      const d = interArrivalMs(rng, 6, 1, { minInterArrivalFactor: 0.9, maxInterArrivalFactor: 1.1 });
      expect(d).toBeGreaterThanOrEqual(mean * 0.9 - 1e-6);
      expect(d).toBeLessThanOrEqual(mean * 1.1 + 1e-6);
    }
  });
});

describe('scaledMs', () => {
  test('compresses a simulated gap', () => {
    expect(scaledMs(60000, 60)).toBe(1000);
    expect(scaledMs(60000)).toBe(60000);
    expect(scaledMs(60000, 0)).toBe(60000);
  });
});
