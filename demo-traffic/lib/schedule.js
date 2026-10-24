// Business-hours gating and inter-arrival times for demo-traffic. Pure
// functions over lib/agent-sim helpers: nothing here sleeps or does I/O.

const { wallClock, parseHHMM } = require('../../lib/agent-sim/time');

/** True when the instant falls inside lab.businessHours (days + start/end in lab.timeZone). */
function isBusinessHours(epochMs, lab) {
    const bh = lab.businessHours;
    const w = wallClock(epochMs, lab.timeZone);
    if (!bh.days.includes(w.dow)) return false;
    return w.minuteOfDay >= parseHHMM(bh.start) && w.minuteOfDay < parseHHMM(bh.end);
}

/**
 * Jittered exponential inter-arrival, in REAL milliseconds. The mean is
 * 3600000 / ratePerHour simulated ms; the draw is clamped to
 * [minFactor, maxFactor] x mean so a stream is neither bunched into a flurry
 * nor silent for hours. timeScale N compresses simulated time N times.
 */
function interArrivalMs(rng, ratePerHour, timeScale = 1, opts = {}) {
    if (!(ratePerHour > 0)) return Infinity;
    const minF = opts.minInterArrivalFactor ?? 0.15;
    const maxF = opts.maxInterArrivalFactor ?? 4;
    const meanMs = 3600000 / ratePerHour;
    const drawMs = rng.expMinutes(ratePerHour) * 60000;
    const clamped = Math.min(Math.max(drawMs, meanMs * minF), meanMs * maxF);
    return clamped / (timeScale > 0 ? timeScale : 1);
}

/** Real ms to wait for a simulated gap (burst spacing); compressed by timeScale. */
function scaledMs(simMs, timeScale = 1) {
    return simMs / (timeScale > 0 ? timeScale : 1);
}

module.exports = { isBusinessHours, interArrivalMs, scaledMs };
