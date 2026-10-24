#!/usr/bin/env node
//
// build.js - bring the demo-traffic users and their devices up to date on a
// server, from demo-traffic/lab.json ("create.users" is the only source).
//
//   node demo-traffic/build.js --server v46 [--dry-run] [--only 4011,5101]
//
// Idempotent: each user and device is POSTed, and on 409 (already exists) PUT.
// It never touches an extension that is not in create.users (it throws), and
// never the demo user or the protected 1000-series users. Writes
// state/demo-traffic/devices.csv (gitignored: it holds SIP passwords) for
// both domains' devices. --dry-run prints the planned requests with secrets
// redacted and works offline (no request is sent, no file is written).

const fs = require('fs');
const path = require('path');
const { loadLab, assertManaged, devicePassword, deviceCsv, redact, REPO, STATE_DIR } = require('./lib/lab');

const enc = encodeURIComponent;
const DEVICES_CSV = path.join(STATE_DIR, 'devices.csv');

/** Requests for one user: the user itself, then its device. Throws unless managed. */
function planUser(lab, user, apikey) {
    assertManaged(lab, user.domain, user.ext, 'create/update');
    const body = {
        'name-first-name': user.first,
        'name-last-name': user.last,
        email: `${user.first}.${user.last}@${lab.emailDomain || 'demo-traffic.example.com'}`.toLowerCase(),
        department: user.department,
        'user-scope': user.scope || 'Basic User',
        'time-zone': lab.timeZone
    };
    if (user.callerIdName) body['caller-id-name'] = user.callerIdName;
    if (user.callerIdNumber) {
        body['caller-id-number'] = user.callerIdNumber;
        body['caller-id-number-emergency'] = user.callerIdNumber;
    }
    const device = {
        'device-sip-registration-password': devicePassword(apikey, user.domain, user.ext),
        'device-sip-nat-traversal': 'automatic'
    };
    const usersPath = `domains/${enc(user.domain)}/users`;
    const devicesPath = `${usersPath}/${enc(user.ext)}/devices`;
    return [
        { label: `user ${user.ext}@${user.domain} (${user.first} ${user.last})`, createPath: usersPath,
          createBody: { user: user.ext, ...body }, updatePath: `${usersPath}/${enc(user.ext)}`, updateBody: body },
        { label: `device ${user.ext}@${user.domain}`, createPath: devicesPath,
          createBody: { device: user.ext, ...device }, updatePath: `${devicesPath}/${enc(user.ext)}`, updateBody: device }
    ];
}

/** Plan for every create.users entry, or only the extensions in `only` (each must be listed). */
function planBuild(lab, apikey, only = null) {
    let users = lab.create.users;
    if (only) {
        users = only.map(ext => {
            const u = lab.create.users.find(x => x.ext === ext);
            if (!u) throw new Error(`Refusing to touch extension ${ext}: not listed in lab.json create.users`);
            return u;
        });
    }
    return users.flatMap(u => planUser(lab, u, apikey));
}

/** What a dry run prints for one request: POST body with secrets redacted. */
function describeRequest(req) {
    return redact(`POST ${req.createPath} ${JSON.stringify(req.createBody)}`)
        .replace(/("device-sip-registration-password":")[^"]*/g, '$1***');
}

async function runBuild({ lab, client, apikey, dryRun, only = null, out = console.log, describeApiError = e => e.message }) {
    const plan = planBuild(lab, apikey, only);
    const result = { planned: plan.length, created: 0, updated: 0, failed: 0 };
    for (const req of plan) {
        if (dryRun) {
            out(`DRY RUN ${req.label}: ${describeRequest(req)}`);
            continue;
        }
        try {
            await client.apiPostJson(req.createPath, { synchronous: 'yes', ...req.createBody });
            result.created++;
            out(`created ${req.label}`);
        } catch (e) {
            if (e?.response?.status !== 409) {
                result.failed++;
                out(`FAILED ${req.label}: ${describeApiError(e)}`);
                continue;
            }
            try {
                await client.apiPutJson(req.updatePath, req.updateBody);
                result.updated++;
                out(`updated ${req.label}`);
            } catch (e2) {
                result.failed++;
                out(`FAILED updating ${req.label}: ${describeApiError(e2)}`);
            }
        }
    }
    const devices = only ? lab.create.users.filter(u => only.includes(u.ext)) : lab.create.users;
    if (dryRun) {
        out(`DRY RUN would write ${path.relative(REPO, DEVICES_CSV)} with ${lab.create.users.length} devices (passwords not shown)`);
    } else if (!only) {
        fs.mkdirSync(path.dirname(DEVICES_CSV), { recursive: true });
        fs.writeFileSync(DEVICES_CSV, deviceCsv(devices, apikey), { mode: 0o600 });
        out(`wrote ${path.relative(REPO, DEVICES_CSV)} (${devices.length} devices)`);
    }
    return result;
}

function parseArgs(argv) {
    const args = { dryRun: argv.includes('--dry-run'), only: null };
    const i = argv.indexOf('--only');
    if (i !== -1) args.only = String(argv[i + 1] || '').split(',').map(s => s.trim()).filter(Boolean);
    return args;
}

async function main() {
    process.chdir(REPO);
    require('dotenv').config({ path: path.join(REPO, '.env') });
    const { loadConfig } = require('../lib/config');
    const { ServerApiClient, describeApiError } = require('../lib/nsapi');
    const { selectedServer } = loadConfig();
    const lab = loadLab();
    if (lab.server && selectedServer.id !== lab.server) {
        throw new Error(`lab.json is for server "${lab.server}" but --server selected "${selectedServer.id}"`);
    }
    const args = parseArgs(process.argv.slice(2));
    const client = args.dryRun ? null : new ServerApiClient(selectedServer);
    console.log(`[${selectedServer.id}] demo-traffic build${args.dryRun ? ' (dry run)' : ''}`);
    const r = await runBuild({ lab, client, apikey: selectedServer.apikey, dryRun: args.dryRun, only: args.only, describeApiError });
    console.log(`[${selectedServer.id}] done: ${r.planned} requests, ${r.created} created, ${r.updated} updated, ${r.failed} failed`);
    if (r.failed) process.exitCode = 1;
}

module.exports = { planUser, planBuild, describeRequest, runBuild, parseArgs, DEVICES_CSV };

if (require.main === module) {
    main().catch(e => { console.error(`FAILED: ${e.message}`); process.exit(1); });
}
