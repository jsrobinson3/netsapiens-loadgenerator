// Event log: one JSON line per action in state/demo-traffic/events.jsonl plus a
// concise stdout line. Dry runs print only (no file is written).

const fs = require('fs');
const path = require('path');
const { STATE_DIR, redact } = require('./lab');

const EVENTS_FILE = path.join(STATE_DIR, 'events.jsonl');

class EventLog {
    constructor({ file = EVENTS_FILE, dryRun = false, out = console.log, now = () => Date.now() } = {}) {
        this.file = file;
        this.dryRun = dryRun;
        this.out = out;
        this.now = now;
    }

    /** @param {object} event  { stream, action, ...detail }; ts is added */
    log(event) {
        const line = { ts: new Date(this.now()).toISOString(), ...(this.dryRun ? { dry: true } : {}), ...event };
        if (!this.dryRun) {
            fs.mkdirSync(path.dirname(this.file), { recursive: true });
            fs.appendFileSync(this.file, redact(JSON.stringify(line)) + '\n');
        }
        this.out(formatLine(line));
        return line;
    }
}

function formatLine(e) {
    const t = e.ts.slice(11, 19);
    const parts = [t, e.dry ? '[dry]' : '', e.stream || '-', e.action];
    const detail = [];
    if (e.from) detail.push(`${e.from} -> ${e.to}`);
    if (e.caller) detail.push(`${e.caller} -> ${e.target}`);
    if (e.status !== undefined) detail.push(`status=${e.status}`);
    if (e.exitCode !== undefined) detail.push(`exit=${e.exitCode}`);
    if (e.talkSeconds !== undefined) detail.push(`talk=${e.talkSeconds}s audio=${e.audio}`);
    if (e.message) detail.push(`"${e.message}"`);
    if (e.reason) detail.push(e.reason);
    if (e.error) detail.push(`error: ${e.error}`);
    let text = [...parts, ...detail].filter(Boolean).join(' ');
    if (e.request) text += `\n  ${e.request} ${JSON.stringify(e.body)}  (sid ${e.sid}, +${Math.round((e.delayMs || 0) / 1000)}s)`;
    return redact(text);
}

module.exports = { EventLog, EVENTS_FILE, formatLine };
