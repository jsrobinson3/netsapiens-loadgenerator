// SIPp command, scenario and CSV generation for demo-traffic. Building is
// pure; writing files and spawning live in run.js / answerers.js. SIPp runs in
// Docker (lab.json sipp.cmd) with the repo bind-mounted at the same path, so
// every file it reads must live under the repo.

const fs = require('fs');
const os = require('os');
const path = require('path');
const dns = require('dns');
const dgram = require('dgram');
const https = require('https');
const { REPO, STATE_DIR, labStateDir, deviceCsv, deviceRow, devicePassword, assertManaged, userByExt } = require('./lab');

const WORK_DIR = path.join(STATE_DIR, 'work'); // the default (un-namespaced) lab
/** Per-lab scratch dir for templated scenarios and CSVs. */
function workDir(lab) {
    return path.join(labStateDir(lab), 'work');
}
const SCRIPTS_DIR = path.join(REPO, 'sipp', 'scripts');
const PCAP_DIR = path.join(SCRIPTS_DIR, 'pcaps');
const UA = 'demo-traffic';

// Ports: clear of the loadgen port-allocator pool and the callback UAS. SIPp runs
// on the host network, so two daemons on one host need disjoint ports: a lab sets
// sipp.portOffset (0-300, default 0); SIP and control ports shift by it and media
// ports by 10x it. Use 0 for the first lab and 300 for the next (any 200+ is clear
// of the default ranges).
const ANSWERER_PORTS = { sip: 5090, control: 5091, media: 61000 };
function offsetOf(lab) {
    return Number(lab?.sipp?.portOffset) || 0;
}
function answererPorts(lab) {
    const o = offsetOf(lab);
    return { sip: ANSWERER_PORTS.sip + o, control: ANSWERER_PORTS.control + o, media: ANSWERER_PORTS.media + 10 * o };
}
function slotPorts(slot, lab) {
    const o = offsetOf(lab);
    return { sip: 5100 + slot + o, control: 5200 + slot + o, media: 62000 + 10 * slot + 10 * o };
}

/** Fill __AUDIO__, __TALK_MS__ and [media_ip] in a copy of sipp_uac_agent_dial.xml. */
function renderDialScenario(xml, { audio, talkMs, mediaIp }) {
    if (!/^[A-Za-z0-9_.-]+$/.test(audio)) throw new Error(`Unsafe audio name "${audio}"`);
    if (!xml.includes('__AUDIO__') || !xml.includes('__TALK_MS__')) {
        throw new Error('Dial scenario template has no __AUDIO__/__TALK_MS__ placeholders');
    }
    let out = xml.split('__AUDIO__').join(audio).split('__TALK_MS__').join(String(Math.round(talkMs)));
    if (mediaIp) out = out.split('[media_ip]').join(mediaIp);
    return out;
}

/** Fill [media_ip] in a copy of the answerer (-oocsf) scenario. */
function renderAnswererScenario(xml, mediaIp) {
    return mediaIp ? xml.split('[media_ip]').join(mediaIp) : xml;
}

/** The one-line SEQUENTIAL CSV for the calling device. */
function callerCsv(user, apikey) {
    return `SEQUENTIAL\r\n${deviceRow(user, devicePassword(apikey, user.domain, user.ext), UA)}\r\n`;
}

/** lab.sipp.cmd -> argv prefix, {REPO} expanded; --name inserted after "docker run". */
function sippPrefix(lab, name) {
    const tokens = String(lab.sipp.cmd).replace(/\{REPO\}/g, REPO).split(/\s+/).filter(Boolean);
    if (name && tokens[0] === 'docker' && tokens[1] === 'run') tokens.splice(2, 0, '--name', name);
    return tokens;
}

function ports(slot, lab) {
    return slot === 'answerers' ? answererPorts(lab) : slotPorts(slot, lab);
}

/**
 * Full argv for one call. `slot` picks the port set; `sut` is the (IPv4 or
 * host) SIP destination.
 */
function buildCallArgv({ lab, name, sut, scenarioPath, csvPath, localIp, slot, target, talkMs }) {
    const p = ports(slot, lab);
    return [
        ...sippPrefix(lab, name),
        sut,
        '-sf', scenarioPath, '-inf', csvPath,
        '-m', '1', '-l', '1',
        '-t', lab.sipp.transport || 'u1',
        '-i', localIp, '-p', String(p.sip), '-cp', String(p.control), '-mp', String(p.media), '-mi', localIp,
        '-key', 'dial_ext', String(target),
        '-key', 'ua_version', UA,
        '-recv_timeout', '60000',
        '-timeout', String(Math.ceil(talkMs / 1000) + 90),
        '-nostdin'
    ];
}

/** Devices the answerers register: lab.answerers.devices, each a managed user (never 4010). */
function answererUsers(lab) {
    return lab.answerers.devices.map(ext => {
        const u = lab.create.users.find(x => x.ext === ext);
        if (!u) throw new Error(`answerers: ${ext} is not in lab.json create.users`);
        assertManaged(lab, u.domain, u.ext, 'register');
        return u;
    });
}

/** Same invocation as sipp/scripts/register.sh, minus -bg and the stats files. */
function buildAnswererArgv({ lab, name, sut, uasPath, csvPath, localIp, count }) {
    const p = answererPorts(lab);
    return [
        ...sippPrefix(lab, name),
        sut,
        '-key', 'expires', '60', '-key', 'ua_version', UA, '-key', 'reg_loops', '78',
        '-r', '5', '-m', String(count), '-l', String(count),
        '-t', lab.sipp.transport || 'u1', '-p', String(p.sip), '-cp', String(p.control),
        '-sf', path.join(SCRIPTS_DIR, lab.sipp.registerScenario),
        '-oocsf', uasPath,
        '-inf', csvPath,
        '-recv_timeout', '60000',
        '-watchdog_interval', '0', '-watchdog_minor_threshold', '920000', '-watchdog_major_threshold', '9200000',
        '-aa', '-default_behaviors', '-abortunexp',
        '-mp', String(p.media), '-i', localIp, '-mi', localIp,
        '-nostdin'
    ];
}

function shellQuote(arg) {
    return /^[A-Za-z0-9_@%+=:,./-]+$/.test(arg) ? arg : `'${String(arg).replace(/'/g, `'\\''`)}'`;
}

function formatCommand(argv) {
    return argv.map(shellQuote).join(' ');
}

function readTemplate(lab, key) {
    return fs.readFileSync(path.join(SCRIPTS_DIR, lab.sipp[key]), 'utf8');
}

function pcapExists(audio) {
    return fs.existsSync(path.join(PCAP_DIR, `${audio}.pcap`));
}

// ---- network discovery (live runs only; dry runs use placeholders) ----

/** First non-internal IPv4 on this host (offline fallback). */
function scanLocalIpv4() {
    for (const addrs of Object.values(os.networkInterfaces())) {
        for (const a of addrs || []) {
            if (a.family === 'IPv4' && !a.internal) return a.address;
        }
    }
    return '127.0.0.1';
}

function resolveIpv4(host) {
    if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) return Promise.resolve(host);
    return dns.promises.lookup(host, { family: 4 }).then(r => r.address).catch(() => host);
}

/** Local address the OS would use to reach `remoteIp` (no packet is sent). */
function localIpFor(remoteIp) {
    return new Promise(resolve => {
        const sock = dgram.createSocket('udp4');
        sock.on('error', () => { try { sock.close(); } catch (e) { /* closed */ } resolve(scanLocalIpv4()); });
        sock.connect(5060, remoteIp, () => {
            const addr = sock.address().address;
            sock.close();
            resolve(addr);
        });
    });
}

/** This host's public IPv4 (the address SIP peers see), or null. */
function publicIpv4() {
    return new Promise(resolve => {
        const req = https.get('https://checkip.amazonaws.com', { timeout: 5000 }, res => {
            let body = '';
            res.on('data', c => { body += c; });
            res.on('end', () => {
                const ip = body.trim();
                resolve(/^\d+\.\d+\.\d+\.\d+$/.test(ip) ? ip : null);
            });
        });
        req.on('timeout', () => { req.destroy(); resolve(null); });
        req.on('error', () => resolve(null));
    });
}

module.exports = {
    WORK_DIR, workDir, SCRIPTS_DIR, PCAP_DIR, UA, ANSWERER_PORTS, answererPorts, slotPorts,
    renderDialScenario, renderAnswererScenario, callerCsv, deviceCsv, userByExt,
    sippPrefix, buildCallArgv, buildAnswererArgv, answererUsers,
    shellQuote, formatCommand, readTemplate, pcapExists,
    scanLocalIpv4, resolveIpv4, localIpFor, publicIpv4
};
