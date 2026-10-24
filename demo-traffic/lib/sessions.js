// Message-session ids. The platform wants a random sid of at least 32
// characters from [A-Za-z0-9_]; the same sid must be reused for the same
// conversation, so the map is persisted to state/demo-traffic/sessions.json.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const SID_RE = /^[A-Za-z0-9_]{32,}$/;

function newSid(randomBytes = crypto.randomBytes) {
    return randomBytes(20).toString('hex'); // 40 chars, [0-9a-f]
}

/**
 * Normalise a number or extension so the same remote always compares equal:
 * strip non-digits and drop the leading 1 of an 11-digit NANP number
 * (9803510486 == 19803510486 == +1 (980) 351-0486). Extensions are unchanged.
 */
function normalizeRemote(value) {
    const digits = String(value == null ? '' : value).replace(/\D/g, '');
    return digits.length === 11 && digits.startsWith('1') ? digits.slice(1) : digits;
}

/** Remote(s) a messagesession lists: a string, or an array / delimited list, normalised. */
function remotesOf(value) {
    const parts = Array.isArray(value) ? value : String(value == null ? '' : value).split(/[,;\s]+/);
    return parts.map(normalizeRemote).filter(Boolean).sort();
}

const sessionId = s => s['messagesession-id'] || s['messagesession'] || s.sid || s.id || null;

/**
 * The sid of an existing session (from GET .../messagesessions) whose
 * `messagesession-remote` equals `wanted` after normalisation, or null.
 * Unusable ids (not SID_RE) are ignored. Newest-first order is not assumed:
 * the first match in the list wins.
 */
function findExistingSid(list, wanted) {
    const want = remotesOf(wanted).join(',');
    const rows = Array.isArray(list) ? list : (list && Array.isArray(list.data) ? list.data : []);
    for (const row of rows) {
        const id = sessionId(row || {});
        if (id && SID_RE.test(id) && remotesOf(row['messagesession-remote']).join(',') === want) return id;
    }
    return null;
}

class SessionStore {
    /**
     * @param {string|null} file  JSON file to persist to (null = memory only)
     * @param {object} opts       { persist: bool (default true), randomBytes: fn }
     */
    constructor(file, opts = {}) {
        this.file = file;
        this.persist = opts.persist !== false && !!file;
        this.randomBytes = opts.randomBytes || crypto.randomBytes;
        this.map = {};
        this.resolved = new Set(); // keys already checked against the server this run
        if (file && fs.existsSync(file)) {
            try {
                const loaded = JSON.parse(fs.readFileSync(file, 'utf8'));
                for (const [k, v] of Object.entries(loaded)) if (SID_RE.test(v)) this.map[k] = v;
            } catch (e) {
                // A corrupt file only costs us the sids: start fresh.
                this.map = {};
            }
        }
    }

    /** One-to-one chat or SMS: one sid per directed pair (sender -> destination). */
    pairKey(domain, sender, destination) {
        return `pair:${domain}:${normalizeRemote(sender)}>${normalizeRemote(destination)}`;
    }

    /** Group chat: one sid per group, shared by every sender. */
    groupKey(domain, groupName) {
        return `group:${domain}:${groupName}`;
    }

    get(key) {
        if (!this.map[key]) {
            this.map[key] = newSid(this.randomBytes);
            this.save();
        }
        return this.map[key];
    }

    set(key, sid) {
        if (!SID_RE.test(sid)) throw new Error('Refusing to store an invalid session id');
        if (this.map[key] !== sid) {
            this.map[key] = sid;
            this.save();
        }
        return sid;
    }

    /**
     * Sid for `key`, reusing a session that already exists on the server.
     * The platform opens a NEW conversation per sid, so before minting we look
     * for one whose remote matches. `fetchList()` returns the user's
     * messagesessions (array); it is called at most once per key per run, and
     * never in a dry run (pass null to skip: the cached or minted sid is used).
     * @returns {Promise<{sid: string, source: 'existing'|'cached'|'new'|'lookup-failed'}>}
     */
    async resolve(key, wanted, fetchList) {
        const had = !!this.map[key];
        if (this.resolved.has(key) || !fetchList) {
            return { sid: this.get(key), source: had ? 'cached' : 'new' };
        }
        let list;
        try {
            list = await fetchList();
        } catch (e) {
            // Do not mark resolved: try again next time rather than fork a thread on a blip.
            return { sid: this.get(key), source: 'lookup-failed', error: e };
        }
        this.resolved.add(key);
        const existing = findExistingSid(list, wanted);
        if (existing) return { sid: this.set(key, existing), source: 'existing' };
        return { sid: this.get(key), source: had ? 'cached' : 'new' };
    }

    save() {
        if (!this.persist) return;
        fs.mkdirSync(path.dirname(this.file), { recursive: true });
        fs.writeFileSync(this.file, JSON.stringify(this.map, null, 2) + '\n');
    }
}

module.exports = { SessionStore, newSid, SID_RE, normalizeRemote, remotesOf, findExistingSid };
