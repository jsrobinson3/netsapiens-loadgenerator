// Loading and safety rules for demo-traffic/lab.json. Side-effect free: the
// only I/O is reading lab.json, so tests can require it without a server.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const REPO = path.join(__dirname, '..', '..');
const LAB_PATH = path.join(__dirname, '..', 'lab.json');
const STATE_DIR = path.join(REPO, 'state', 'demo-traffic');

// Never touched or acted as, whatever lab.json says. lab.json "protected"
// adds to these; it cannot remove them.
const HARD_PROTECTED = {
    sumnersawesomephones: ['4010', '1001', '1002', '2000', '6300', '8001'],
    'onecloud-sbz': Array.from({ length: 13 }, (_, i) => String(1000 + i))
};

function loadLab(file = LAB_PATH) {
    const lab = JSON.parse(fs.readFileSync(file, 'utf8'));
    validateLab(lab);
    return lab;
}

function protectedSet(lab) {
    const set = new Set();
    for (const src of [HARD_PROTECTED, lab.protected || {}]) {
        for (const [domain, exts] of Object.entries(src)) {
            for (const ext of exts) set.add(`${domain}/${ext}`);
        }
    }
    return set;
}

function validateLab(lab) {
    const problems = [];
    if (!lab.demoUser?.domain || !lab.demoUser?.ext || !lab.demoUser?.did) problems.push('demoUser needs domain, ext and did');
    if (lab.options?.allowDemoUserReplies) {
        problems.push('options.allowDemoUserReplies must stay false: demo-traffic never acts as the demo user');
    }
    if (lab.chatTransport !== undefined && !['matrix', 'messagesessions'].includes(lab.chatTransport)) {
        problems.push('chatTransport must be "matrix" or "messagesessions"');
    }
    const prot = protectedSet(lab);
    const seen = new Set();
    for (const u of lab.create?.users || []) {
        const key = `${u.domain}/${u.ext}`;
        if (prot.has(key)) problems.push(`create.users lists protected user ${key}`);
        if (key === `${lab.demoUser?.domain}/${lab.demoUser?.ext}`) problems.push(`create.users lists the demo user ${key}`);
        if (seen.has(key)) problems.push(`create.users lists ${key} twice`);
        seen.add(key);
        if (u.callerIdName && u.callerIdName.length > 15) problems.push(`${key} callerIdName "${u.callerIdName}" is over 15 characters`);
    }
    if (problems.length) throw new Error(`Invalid lab.json: ${problems.join('; ')}`);
}

/** The users demo-traffic may create or act as, keyed "domain/ext". */
function managedUsers(lab) {
    const map = new Map();
    for (const u of lab.create.users) map.set(`${u.domain}/${u.ext}`, u);
    return map;
}

function isProtected(lab, domain, ext) {
    return protectedSet(lab).has(`${domain}/${ext}`);
}

/** Throws unless (domain, ext) is in create.users and not protected. */
function assertManaged(lab, domain, ext, what = 'act as') {
    if (isProtected(lab, domain, ext)) {
        throw new Error(`Refusing to ${what} protected user ${ext}@${domain}`);
    }
    if (!managedUsers(lab).has(`${domain}/${ext}`)) {
        throw new Error(`Refusing to ${what} ${ext}@${domain}: not listed in lab.json create.users`);
    }
}

/** True for an extension demo-traffic may send chat/calls to (managed users and the demo user). */
function isKnownTarget(lab, domain, ext) {
    if (domain === lab.demoUser.domain && ext === lab.demoUser.ext) return true;
    return managedUsers(lab).has(`${domain}/${ext}`);
}

function userByExt(lab, domain, ext) {
    return managedUsers(lab).get(`${domain}/${ext}`) || null;
}

// SIP password for a device: stable per server API key, domain and extension.
function devicePassword(apikey, domain, ext) {
    return crypto.createHmac('sha256', apikey)
        .update(`demo-traffic:${domain}:${ext}`).digest('base64url').slice(0, 20);
}

/** SEQUENTIAL SIPp device CSV rows (CRLF): displayName;ext;domain;[authentication ...];userAgent */
function deviceRow(user, password, ua = 'demo-traffic') {
    return `${user.first} ${user.last};${user.ext};${user.domain};[authentication username=${user.ext} password=${password}];${ua}`;
}

function deviceCsv(users, apikey) {
    const rows = users.map(u => deviceRow(u, devicePassword(apikey, u.domain, u.ext)));
    return ['SEQUENTIAL', ...rows].join('\r\n') + '\r\n';
}

/** Hide every SIP password in a string. */
function redact(text) {
    return String(text).replace(/(password=)[^\s\]]+/g, '$1***');
}

module.exports = {
    REPO, LAB_PATH, STATE_DIR, HARD_PROTECTED,
    loadLab, validateLab, managedUsers, isProtected, assertManaged, isKnownTarget, userByExt,
    devicePassword, deviceRow, deviceCsv, redact
};
