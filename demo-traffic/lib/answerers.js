// The answerers: ONE SIPp registration process that keeps every device in
// lab.answerers.devices registered (and answering calls with media) so calls
// to them connect. Mirrors sipp/scripts/register.sh. The scenario exits after
// about 58 minutes (reg_loops 78 x 60s expiry), so it is restarted when it
// exits. Never registers the demo user (answererUsers asserts managed).

const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { REPO, redact } = require('./lab');
const sipp = require('./sipp');

const CONTAINER = 'demo-traffic-answerers';

/** Everything an answerer start needs, without writing or spawning. */
function prepareAnswerers(lab, { apikey, sut, localIp, mediaIp, uasTemplate }) {
    const users = sipp.answererUsers(lab);
    const uasPath = path.join(sipp.WORK_DIR, 'answerers-uas.xml');
    const csvPath = path.join(sipp.WORK_DIR, 'answerers.csv');
    const csv = sipp.deviceCsv(users, apikey);
    const argv = sipp.buildAnswererArgv({
        lab, name: CONTAINER, sut, uasPath, csvPath, localIp, count: users.length
    });
    return {
        users, uasPath, csvPath, csv, argv, cwd: sipp.SCRIPTS_DIR,
        uasXml: uasTemplate ? sipp.renderAnswererScenario(uasTemplate, mediaIp) : null
    };
}

class Answerers {
    constructor({ lab, apikey, net, dryRun, events, spawnFn = spawn, spawnSyncFn = spawnSync, backoffMs = [5000, 15000, 60000] }) {
        this.lab = lab;
        this.apikey = apikey;
        this.net = net;
        this.dryRun = dryRun;
        this.events = events;
        this.spawnFn = spawnFn;
        this.spawnSyncFn = spawnSyncFn;
        this.backoffMs = backoffMs;
        this.child = null;
        this.stopping = false;
        this.failures = 0;
        this.timer = null;
    }

    async start() {
        const netInfo = await this.net();
        const uasTemplate = sipp.readTemplate(this.lab, 'answererScenario');
        const p = prepareAnswerers(this.lab, { apikey: this.apikey, ...netInfo, uasTemplate });
        const ev = { stream: 'answerers', devices: p.users.map(u => u.ext).join(',') };
        if (this.dryRun) {
            this.events.log({ ...ev, action: 'answerers-dry-run' });
            console.log(`  cwd:     ${path.relative(REPO, p.cwd)}`);
            console.log(`  command: ${redact(sipp.formatCommand(p.argv))}`);
            console.log(`  csv:     ${redact(p.csv).replace(/\r\n/g, ' | ')}`);
            return p;
        }
        fs.mkdirSync(sipp.WORK_DIR, { recursive: true });
        fs.writeFileSync(p.uasPath, p.uasXml);
        fs.writeFileSync(p.csvPath, p.csv, { mode: 0o600 });
        this.prepared = p;
        this.launch(ev);
        return p;
    }

    launch(ev) {
        // A previous container (crashed daemon) would hold the name and the ports.
        this.spawnSyncFn('docker', ['rm', '-f', CONTAINER], { stdio: 'ignore' });
        const [file, ...args] = this.prepared.argv;
        const startedAt = Date.now();
        this.events.log({ ...ev, action: 'answerers-start' });
        const child = this.spawnFn(file, args, { cwd: this.prepared.cwd, stdio: 'ignore' });
        this.child = child;
        child.on('error', err => this.onExit(ev, startedAt, -1, err.message));
        child.on('exit', code => this.onExit(ev, startedAt, code === null ? -1 : code));
    }

    onExit(ev, startedAt, code, error) {
        if (this.child === null) return; // already handled (error then exit)
        this.child = null;
        if (this.stopping) return;
        // A run that lasted a while was healthy (the scenario ends by design): restart quickly.
        this.failures = Date.now() - startedAt > 120000 ? 0 : this.failures + 1;
        const wait = this.failures === 0 ? 1000 : this.backoffMs[Math.min(this.failures - 1, this.backoffMs.length - 1)];
        this.events.log({ ...ev, action: 'answerers-exited', exitCode: code, ...(error ? { error } : {}), reason: `restarting in ${Math.round(wait / 1000)}s` });
        this.timer = setTimeout(() => { if (!this.stopping) this.launch(ev); }, wait);
    }

    /** Stop the registration process and remove its container. */
    stop() {
        this.stopping = true;
        if (this.timer) clearTimeout(this.timer);
        if (this.child || this.prepared) {
            this.spawnSyncFn('docker', ['kill', CONTAINER], { stdio: 'ignore' });
            this.spawnSyncFn('docker', ['rm', '-f', CONTAINER], { stdio: 'ignore' });
        }
        if (this.child) {
            try { this.child.kill('SIGTERM'); } catch (e) { /* already gone */ }
        }
        this.child = null;
        for (const f of ['answerers-uas.xml', 'answerers.csv']) {
            try { fs.unlinkSync(path.join(sipp.WORK_DIR, f)); } catch (e) { /* none */ }
        }
        if (this.events) this.events.log({ stream: 'answerers', action: 'answerers-stopped' });
    }
}

module.exports = { Answerers, prepareAnswerers, CONTAINER };
