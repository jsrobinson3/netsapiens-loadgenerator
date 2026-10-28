#!/usr/bin/env node
//
// run.js - the demo-traffic daemon: realistic calls, 1:1 chat, group chat (and,
// once enabled, SMS and shared-inbox traffic) around the demo user, driven by a
// lab file (default demo-traffic/lab.json).
//
//   node demo-traffic/run.js --server v46 [--lab <path>] [--dry-run] [--once <stream>]
//                            [--time-scale N] [--ignore-hours]
//
//   --lab <path>     lab file to run (default demo-traffic/lab.json; relative
//                    paths resolve from the repo root). Its "id" (default: the
//                    file's basename) namespaces state under state/demo-traffic/<id>/
//                    so several environments can run side by side; the default
//                    lab.json without an "id" keeps the original state/demo-traffic/.
//   --dry-run        log the API requests and the full SIPp commands (SIP
//                    passwords redacted); send nothing, spawn nothing
//   --once <stream>  fire exactly one event of that stream now, then exit
//   --time-scale N   compress time N times (inter-arrivals, burst gaps and
//                    the business-hours clock)
//   --ignore-hours   run outside business hours too
//
// Streams: chatToDemo chatCrossTalk groupChat sms inbox callsToDemo callsToInbox callsCrossTalk
// Never acts as the demo user (ext 4010) or any protected user; see README.md.

const path = require('path');
const { loadLab, redact, findPlaceholders, labStateDir, REPO } = require('./lib/lab');
const { makeRng } = require('../lib/agent-sim/rng');
const { SimClock } = require('../lib/agent-sim/time');
const { SessionStore } = require('./lib/sessions');
const { EventLog } = require('./lib/events');
const { Engine } = require('./lib/engine');
const { CallRunner } = require('./lib/calls');
const { Answerers } = require('./lib/answerers');
const { ALL_STREAMS } = require('./lib/streams');
const sipp = require('./lib/sipp');
const { MatrixTransport, RoomStore } = require('./lib/matrix');
const { chatTransport } = require('./lib/streams');

function parseArgs(argv) {
    const val = flag => { const i = argv.indexOf(flag); return i === -1 ? null : argv[i + 1]; };
    const args = {
        dryRun: argv.includes('--dry-run'),
        ignoreHours: argv.includes('--ignore-hours'),
        once: val('--once'),
        lab: val('--lab') === null ? undefined : val('--lab'),
        timeScale: val('--time-scale') === null ? 1 : Number(val('--time-scale'))
    };
    if (argv.includes('--lab') && !args.lab) throw new Error('--lab needs a path to a lab file');
    if (!(args.timeScale > 0)) throw new Error('--time-scale must be a positive number');
    if (argv.includes('--once') && !args.once) throw new Error(`--once needs a stream: ${ALL_STREAMS.join(', ')}`);
    if (args.once && !ALL_STREAMS.includes(args.once)) throw new Error(`Unknown stream "${args.once}". Streams: ${ALL_STREAMS.join(', ')}`);
    return args;
}

// Network facts SIPp needs. A dry run uses placeholders, so it works offline.
function makeNet(selectedServer, dryRun) {
    let cached = null;
    return async () => {
        if (cached) return cached;
        const host = selectedServer.sasHostname || selectedServer.hostname;
        if (dryRun) {
            cached = { sut: host, localIp: sipp.scanLocalIpv4(), mediaIp: '<public-ipv4>' };
        } else {
            const sut = await sipp.resolveIpv4(host);
            const localIp = await sipp.localIpFor(sut);
            const mediaIp = (await sipp.publicIpv4()) || localIp;
            cached = { sut, localIp, mediaIp };
        }
        return cached;
    };
}

async function main() {
    process.chdir(REPO);
    require('dotenv').config({ path: path.join(REPO, '.env') });
    const { loadConfig } = require('../lib/config');
    const { ServerApiClient, describeApiError } = require('../lib/nsapi');
    const args = parseArgs(process.argv.slice(2));
    const { selectedServer } = loadConfig();
    const lab = loadLab(args.lab);
    if (lab.server && selectedServer.id !== lab.server) {
        throw new Error(`the lab file is for server "${lab.server}" but --server selected "${selectedServer.id}"`);
    }
    const todo = findPlaceholders(lab);
    if (todo.length) {
        throw new Error(`the lab file still has TODO placeholders (fill them from the inventory): ${todo.slice(0, 8).join(', ')}${todo.length > 8 ? `, ... (${todo.length} total)` : ''}`);
    }
    const stateDir = labStateDir(lab);

    const events = new EventLog({ dryRun: args.dryRun, file: path.join(stateDir, 'events.jsonl') });
    const sessions = new SessionStore(path.join(stateDir, 'sessions.json'), { persist: !args.dryRun });
    const busy = new Set();
    const net = makeNet(selectedServer, args.dryRun);
    const calls = new CallRunner({ lab, apikey: selectedServer.apikey, net, dryRun: args.dryRun, events, busy });
    // v46 chat goes through Matrix; a dry run builds nothing (no tokens, no network).
    const matrix = !args.dryRun && chatTransport(lab) === 'matrix'
        ? new MatrixTransport({
            host: selectedServer.hostname, apikey: selectedServer.apikey, lab,
            rooms: new RoomStore(path.join(stateDir, 'matrix-rooms.json'))
        })
        : null;
    const engine = new Engine({
        lab, sessions, events, calls, busy, matrix,
        rng: makeRng(`${lab.seed}:${Date.now()}`),
        clock: new SimClock(args.timeScale),
        api: args.dryRun ? null : new ServerApiClient(selectedServer),
        dryRun: args.dryRun, timeScale: args.timeScale, ignoreHours: args.ignoreHours,
        describeApiError
    });

    console.log(`[${selectedServer.id}] demo-traffic${lab.id ? ` lab ${lab.id}` : ''}${args.dryRun ? ' (dry run)' : ''}${args.once ? ` --once ${args.once}` : ''}`);

    if (args.once) {
        await engine.fire(args.once);
        return;
    }

    const answerers = new Answerers({ lab, apikey: selectedServer.apikey, net, dryRun: args.dryRun, events });
    await answerers.start();
    if (args.dryRun) {
        events.log({ stream: '-', action: 'dry-run', reason: `would schedule: ${engine.enabledStreams().join(', ')}. The daemon loop is not started in a dry run; use --once <stream> to preview one event.` });
        return;
    }
    const streams = engine.start();
    events.log({
        stream: '-', action: 'started',
        reason: `streams: ${streams.join(', ')}; time-scale ${args.timeScale}; ${args.ignoreHours ? 'ignoring business hours' : 'business hours only'}`
    });

    let stopping = false;
    const shutdown = async signal => {
        if (stopping) {
            events.log({ stream: '-', action: 'force-stop', reason: `second ${signal}: killing in-flight calls` });
            calls.killAll();
            answerers.stop();
            process.exit(1);
        }
        stopping = true;
        events.log({ stream: '-', action: 'stopping', reason: `${signal}: finishing in-flight calls (send again to force)` });
        answerers.stop();
        await engine.stop();
        events.log({ stream: '-', action: 'stopped' });
        process.exit(0);
    };
    process.on('SIGINT', () => shutdown('SIGINT'));
    process.on('SIGTERM', () => shutdown('SIGTERM'));
}

module.exports = { parseArgs, makeNet };

if (require.main === module) {
    main().catch(e => { console.error(`FAILED: ${redact(e.message)}`); process.exit(1); });
}
