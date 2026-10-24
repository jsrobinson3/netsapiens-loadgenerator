// Placing one SIPp call: build the templated scenario copy, the one-line
// device CSV and the docker command; run it under a concurrency cap and clean
// the temp files up. prepareCall() is pure so tests can inspect everything.

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { REPO, redact } = require('./lab');
const sipp = require('./sipp');

/**
 * @param plan  { caller, target, audio, talkMs }  (from streams.js)
 * @param env   { lab, apikey, sut, localIp, mediaIp, slot, id, dialTemplate }
 */
function prepareCall(plan, env) {
    const { lab, apikey, sut, localIp, mediaIp, slot, id, dialTemplate } = env;
    const name = `demo-traffic-call-${id}`;
    const scenarioPath = path.join(sipp.WORK_DIR, `call-${id}.xml`);
    const csvPath = path.join(sipp.WORK_DIR, `call-${id}.csv`);
    const scenarioXml = sipp.renderDialScenario(dialTemplate, { audio: plan.audio, talkMs: plan.talkMs, mediaIp });
    const csv = sipp.callerCsv(plan.caller, apikey);
    const argv = sipp.buildCallArgv({
        lab, name, sut, scenarioPath, csvPath, localIp, slot, target: plan.target, talkMs: plan.talkMs
    });
    return { name, scenarioPath, csvPath, scenarioXml, csv, argv, cwd: sipp.SCRIPTS_DIR };
}

class CallRunner {
    constructor({ lab, apikey, net, dryRun, events, busy, spawnFn = spawn, now = () => Date.now() }) {
        this.lab = lab;
        this.apikey = apikey;
        this.net = net;          // async () => { sut, localIp, mediaIp }
        this.dryRun = dryRun;
        this.events = events;
        this.busy = busy;        // Set of extensions currently in a demo call
        this.spawnFn = spawnFn;
        this.now = now;
        this.cap = lab.options.maxConcurrentCalls || 2;
        this.slots = new Array(this.cap).fill(false);
        this.running = new Map(); // id -> child
        this.seq = 0;
        this.dialTemplate = null;
    }

    get active() { return this.running.size; }

    freeSlot() {
        const i = this.slots.indexOf(false);
        return i === -1 ? null : i;
    }

    async run(plan) {
        const ev = { stream: plan.stream, caller: plan.caller.ext, target: plan.targetLabel };
        const slot = this.freeSlot();
        if (slot === null) {
            this.events.log({ ...ev, action: 'call-skipped', reason: `concurrent call cap (${this.cap}) reached` });
            return { ok: true, skipped: true };
        }
        if (!sipp.pcapExists(plan.audio)) {
            this.events.log({ ...ev, action: 'call-failed', error: `pcap ${plan.audio}.pcap not found in sipp/scripts/pcaps` });
            return { ok: false };
        }
        this.slots[slot] = true;
        const id = `${process.pid}-${++this.seq}`;
        const demoExt = this.lab.demoUser.ext;
        const busyKeys = [plan.caller.ext, plan.target === this.lab.demoUser.did ? demoExt : plan.target];
        try {
            const netInfo = await this.net();
            if (!this.dialTemplate) this.dialTemplate = sipp.readTemplate(this.lab, 'dialScenario');
            const p = prepareCall(plan, {
                lab: this.lab, apikey: this.apikey, ...netInfo, slot, id, dialTemplate: this.dialTemplate
            });
            const talkSeconds = Math.round(plan.talkMs / 1000);
            const detail = { ...ev, talkSeconds, audio: plan.audio };
            if (this.dryRun) {
                this.events.log({ ...detail, action: 'call-dry-run' });
                console.log(`  cwd:     ${path.relative(REPO, p.cwd)}`);
                console.log(`  command: ${redact(sipp.formatCommand(p.argv))}`);
                console.log(`  scenario: ${path.relative(REPO, p.scenarioPath)} = sipp_uac_agent_dial.xml with __AUDIO__=${plan.audio} __TALK_MS__=${plan.talkMs} [media_ip]=${netInfo.mediaIp}`);
                console.log(`  csv:     ${redact(p.csv).replace(/\r\n/g, ' | ')}`);
                return { ok: true, dry: true };
            }
            fs.mkdirSync(sipp.WORK_DIR, { recursive: true });
            fs.writeFileSync(p.scenarioPath, p.scenarioXml);
            fs.writeFileSync(p.csvPath, p.csv, { mode: 0o600 });
            busyKeys.forEach(k => this.busy.add(k));
            this.events.log({ ...detail, action: 'call-start', slot });
            const started = this.now();
            const code = await this.spawnAndWait(id, p);
            this.events.log({
                ...detail, action: 'call-end', exitCode: code, seconds: Math.round((this.now() - started) / 1000)
            });
            return { ok: code === 0, exitCode: code };
        } catch (e) {
            this.events.log({ ...ev, action: 'call-failed', error: e.message });
            return { ok: false };
        } finally {
            this.slots[slot] = false;
            busyKeys.forEach(k => this.busy.delete(k));
            this.cleanup(id);
        }
    }

    spawnAndWait(id, p) {
        return new Promise(resolve => {
            const [file, ...args] = p.argv;
            const child = this.spawnFn(file, args, { cwd: p.cwd, stdio: 'ignore' });
            this.running.set(id, { child, name: p.name });
            child.on('error', () => { this.running.delete(id); resolve(-1); });
            child.on('exit', code => { this.running.delete(id); resolve(code === null ? -1 : code); });
        });
    }

    cleanup(id) {
        for (const f of [`call-${id}.xml`, `call-${id}.csv`]) {
            try { fs.unlinkSync(path.join(sipp.WORK_DIR, f)); } catch (e) { /* already gone */ }
        }
    }

    /** Force-stop in-flight calls (second Ctrl-C). */
    killAll() {
        for (const { child, name } of this.running.values()) {
            try { require('child_process').spawnSync('docker', ['kill', name], { stdio: 'ignore' }); } catch (e) { /* ignore */ }
            try { child.kill('SIGKILL'); } catch (e) { /* ignore */ }
        }
    }

    /** Resolve when no call is in flight. */
    async drain(pollMs = 500) {
        while (this.running.size) await new Promise(r => setTimeout(r, pollMs));
    }
}

module.exports = { prepareCall, CallRunner };
