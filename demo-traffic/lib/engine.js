// The demo-traffic scheduler. For each enabled stream it waits a jittered
// exponential inter-arrival, and if the (simulated) clock is inside business
// hours, plans one event (streams.js) and executes it: message steps go to
// the API, calls go to the CallRunner. Every dependency is injected, so the
// tests drive it with fakes and a fake clock and never touch the network.

const { planStream, MESSAGE_STREAMS, CALL_STREAMS, ALL_STREAMS, messagePath } = require('./streams');
const { isBusinessHours, interArrivalMs } = require('./schedule');
const { describeStep } = require('./matrix');

class Engine {
    /**
     * @param {object} d
     *   lab, rng, sessions, events           (required)
     *   api        { apiPostJson(path, body) }   (live message sends)
     *   matrix     MatrixTransport { send(step.matrix, text) } (v46 chat; live only, a dry run never calls it)
     *   calls      { run(plan), active, drain() } (call streams)
     *   clock      { now() }                       (SimClock-compatible)
     *   busy       Set of extensions in a demo call (shared with CallRunner)
     *   dryRun, timeScale, ignoreHours
     *   describeApiError(e)
     *   setTimer / clearTimer                       (default setTimeout/clearTimeout)
     *   wait(ms)                                    (default: interruptible sleep, cut short by stop())
     */
    constructor(d) {
        Object.assign(this, {
            clock: { now: () => Date.now() }, busy: new Set(), dryRun: false, timeScale: 1, ignoreHours: false,
            describeApiError: e => (e && e.message) || String(e),
            setTimer: setTimeout, clearTimer: clearTimeout
        }, d);
        this.sleepers = new Set();
        this.timers = new Map();
        this.inflight = new Set();
        this.stopping = false;
        this.quiet = false;
    }

    /** Streams the daemon schedules: lab.streams.<name>.enabled !== false. */
    enabledStreams() {
        return ALL_STREAMS.filter(n => this.lab.streams[n] && this.lab.streams[n].enabled !== false);
    }

    inBusinessHours() {
        return this.ignoreHours || isBusinessHours(this.clock.now(), this.lab);
    }

    /** Plan and execute one event of `name` now (no hours gating). */
    async fire(name) {
        if (!ALL_STREAMS.includes(name)) throw new Error(`Unknown stream "${name}". Streams: ${ALL_STREAMS.join(', ')}`);
        const plan = planStream(name, {
            lab: this.lab, rng: this.rng, sessions: this.sessions, timeScale: this.timeScale, busy: this.busy,
            now: this.clock.now()
        });
        if (plan.kind === 'skip') {
            this.events.log({ stream: name, action: 'skipped', reason: plan.reason });
            return { plan, results: [] };
        }
        if (plan.kind === 'call') {
            const result = await this.calls.run(plan);
            return { plan, results: [result] };
        }
        return { plan, results: await this.executeMessages(plan) };
    }

    /**
     * Live only: reuse a messagesession that already exists on the server for
     * each conversation in the plan (a new sid would open a new thread in the
     * softphone). One GET per conversation key per run; steps are rewritten to
     * the resolved sid. A dry run skips the GET and keeps the cached/minted sid.
     */
    async reconcileSessions(plan) {
        if (this.dryRun || !this.api) return;
        const done = new Map();
        for (const step of plan.steps) {
            if (!step.key) continue;
            if (!done.has(step.key)) {
                const fetchList = async () => {
                    const res = await this.api.apiGet(`domains/${encodeURIComponent(step.domain)}/users/${encodeURIComponent(step.user)}/messagesessions`);
                    return res.data;
                };
                const r = await this.sessions.resolve(step.key, step.remotes, fetchList);
                done.set(step.key, r.sid);
                if (r.source === 'existing' || r.source === 'lookup-failed') {
                    this.events.log({
                        stream: plan.stream, action: r.source === 'existing' ? 'session-reused' : 'session-lookup-failed',
                        from: `${step.user}@${step.domain}`, to: step.to, sid: r.sid,
                        ...(r.error ? { error: this.describeApiError(r.error) } : {})
                    });
                }
            }
            step.sid = done.get(step.key);
            step.path = messagePath(step.domain, step.user, step.sid);
        }
    }

    async executeMessages(plan) {
        await this.reconcileSessions(plan);
        const results = [];
        for (const step of plan.steps) {
            if (step.delayMs > 0 && !this.dryRun) {
                await this.pause(step.delayMs);
                // Shutdown drops the rest of a burst rather than waiting minutes for it.
                if (this.stopping) break;
            }
            results.push(await this.sendStep(plan, step));
        }
        return results;
    }

    pause(ms) {
        if (this.wait) return this.wait(ms);
        return new Promise(resolve => {
            const sleeper = { resolve, timer: this.setTimer(() => { this.sleepers.delete(sleeper); resolve(); }, ms) };
            this.sleepers.add(sleeper);
        });
    }

    async sendStep(plan, step) {
        const ev = {
            stream: plan.stream, from: `${step.user}@${step.domain}`, to: step.to,
            sid: step.sid, message: step.body.message
        };
        if (step.transport === 'matrix') return this.sendMatrix(plan, step, ev);
        if (this.dryRun) {
            this.events.log({ ...ev, action: 'message-dry-run', delayMs: step.delayMs, request: `POST ${step.path}`, body: step.body });
            return { ok: true, dry: true };
        }
        try {
            const res = await this.api.apiPostJson(step.path, step.body);
            this.events.log({ ...ev, action: 'message-sent', status: res.status });
            return { ok: true, status: res.status };
        } catch (e) {
            this.events.log({ ...ev, action: 'message-failed', error: this.describeApiError(e) });
            return { ok: false };
        }
    }

    /** A v46 chat step: planned Matrix steps in a dry run (offline), the Matrix transport live. */
    async sendMatrix(plan, step, ev) {
        if (this.dryRun) {
            this.events.log({
                ...ev, action: 'message-dry-run', delayMs: step.delayMs,
                request: describeStep(step.matrix, step.matrix.groupName), body: step.body
            });
            return { ok: true, dry: true };
        }
        try {
            const r = await this.matrix.send(step.matrix, step.body.message);
            this.events.log({ ...ev, action: 'message-sent', status: r.status, room: r.roomId });
            return { ok: true, status: r.status };
        } catch (e) {
            this.events.log({ ...ev, action: 'message-failed', error: this.describeApiError(e) });
            return { ok: false };
        }
    }

    // ---- daemon loop ----

    start() {
        for (const name of this.enabledStreams()) this.schedule(name);
        return this.enabledStreams();
    }

    schedule(name) {
        if (this.stopping) return;
        const cfg = this.lab.streams[name];
        const delay = interArrivalMs(this.rng, cfg.ratePerHour, this.timeScale, this.lab.options);
        if (!Number.isFinite(delay)) return;
        this.timers.set(name, this.setTimer(() => this.tick(name), delay));
    }

    tick(name) {
        this.timers.delete(name);
        if (this.stopping) return;
        if (!this.inBusinessHours()) {
            if (!this.quiet) {
                this.quiet = true;
                this.events.log({ stream: '-', action: 'quiet-hours', reason: 'outside business hours, no traffic (use --ignore-hours to override)' });
            }
            this.schedule(name);
            return;
        }
        this.quiet = false;
        const p = this.fire(name)
            .catch(e => this.events.log({ stream: name, action: 'error', error: e.message }))
            .finally(() => this.inflight.delete(p));
        this.inflight.add(p);
        this.schedule(name);
    }

    /** Stop scheduling; resolve when in-flight events (including calls) finish. */
    async stop() {
        this.stopping = true;
        for (const t of this.timers.values()) this.clearTimer(t);
        this.timers.clear();
        for (const s of this.sleepers) { this.clearTimer(s.timer); s.resolve(); }
        this.sleepers.clear();
        await Promise.all([...this.inflight]);
        if (this.calls) await this.calls.drain();
    }
}

module.exports = { Engine, MESSAGE_STREAMS, CALL_STREAMS, ALL_STREAMS };
