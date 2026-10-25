// v46 chat over Matrix. On NetSapiens v46 the phone (and Horizon) read chat from
// Matrix, never from the NS messagesessions API, so chat sent there is invisible.
// This mirrors AgentV2 handoff_bridge/adapters/v46.py (conventions ported, nothing
// imported):
//
//   1. delegated NS JWT for the sender   POST /ns-api/v2/jwt          (server apikey)
//   2. Matrix token for that sender      POST /ns-api/v2/matrix/token (that JWT)
//      stable device id per identity; cached in memory; re-minted only on a Matrix 401
//      (retried once); 404 = v45 core, no Matrix
//   3. homeserver = the NS host origin   https://{host}/_matrix/client/v3/...
//   4. peer Matrix ids come from the SENDER's contacts (`matrix-user-id`), never
//      built from the extension; cached DIRECTORY_TTL like AgentV2
//   5. 1:1: reuse the LAST room listed for the peer in the sender's m.direct, else
//      createRoom (Horizon's trusted_private_chat) and append to m.direct
//   6. group: a named private room, created once by the first sender with everyone
//      else invited, then remembered (state/demo-traffic/matrix-rooms.json)
//   7. demo colleagues never run a client, so when one is invited the generator
//      JOINs as that colleague. Never as the demo user or any non-managed user.
//
// The http function is injected: http(method, url, {headers, body}) resolves to
// {status, data} and does NOT throw on non-2xx. Tokens and the apikey are never
// logged or put in error messages.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { assertManaged, isProtected, managedUsers } = require('./lab');

const enc = encodeURIComponent;
const DIRECTORY_TTL_MS = 60 * 1000;
const DEVICE_NAME = 'demo-traffic';

class MatrixError extends Error {
    constructor(message, status) {
        super(message);
        this.name = 'MatrixError';
        this.status = status;
    }
}

/** Stable per identity: re-minting the same id revokes the previous token, a new id piles up devices. */
function deviceId(ext) {
    return `DEMOTRAFFIC${ext}`;
}

function mxidOf(row) {
    return String(row['matrix-user-id'] || row.matrix_user_id || '').trim().toLowerCase();
}

/** Default http: axios, never throws on a status code. */
function defaultHttp() {
    const axios = require('axios');
    return async (method, url, { headers, body } = {}) => {
        const res = await axios.request({ method, url, headers, data: body, timeout: 30000, validateStatus: () => true });
        return { status: res.status, data: res.data };
    };
}

/** Group room ids by key (`group:<domain>:<name>`), persisted so a restart reuses the room. */
class RoomStore {
    constructor(file, opts = {}) {
        this.file = file;
        this.persist = opts.persist !== false && !!file;
        this.map = {};
        if (file && fs.existsSync(file)) {
            try {
                const loaded = JSON.parse(fs.readFileSync(file, 'utf8'));
                for (const [k, v] of Object.entries(loaded)) if (typeof v === 'string' && v.startsWith('!')) this.map[k] = v;
            } catch (e) {
                this.map = {}; // a corrupt file only costs us the room ids
            }
        }
    }

    groupKey(domain, name) {
        return `group:${domain}:${name}`;
    }

    get(key) {
        return this.map[key] || null;
    }

    set(key, roomId) {
        if (this.map[key] !== roomId) {
            this.map[key] = roomId;
            if (this.persist) {
                fs.mkdirSync(path.dirname(this.file), { recursive: true });
                fs.writeFileSync(this.file, JSON.stringify(this.map, null, 2) + '\n');
            }
        }
        return roomId;
    }
}

/** What a dry run prints for one message: the planned Matrix steps, no tokens, no network. */
function describeStep(m, groupName) {
    const to = [].concat(m.to).join(',');
    const lines = [
        `jwt+token for ${m.from}@${m.domain} (device ${deviceId(m.from)}, cached, re-minted on 401)`,
        `peer Matrix id(s) from ${m.from}'s contacts: ${to}`
    ];
    if (m.group) {
        lines.push(`group "${groupName || m.group}": reuse saved room else createRoom(private_chat, invite all) + join as colleagues`);
    } else {
        lines.push('1:1: reuse last m.direct room else createRoom(trusted_private_chat, is_direct) + join colleague + m.direct');
    }
    lines.push('PUT /rooms/{room}/send/m.room.message/{txn}');
    return `MATRIX ${lines.join(' > ')}`;
}

class MatrixTransport {
    /**
     * @param {object} d
     *   host     NS host (e.g. onecloud-sbz.ucaas.tech); homeserver is the same origin
     *   apikey   server API key (only ever sent to /ns-api/v2/jwt)
     *   lab      lab.json (safety rules)
     *   http     injected http (see top of file)
     *   rooms    RoomStore (group room ids)
     *   now      () => ms, monotonic-ish clock for the contacts TTL
     *   randomId () => unique txn id
     */
    constructor(d) {
        Object.assign(this, {
            http: defaultHttp(), rooms: new RoomStore(null, { persist: false }),
            now: () => Date.now(), ttlMs: DIRECTORY_TTL_MS,
            randomId: () => crypto.randomBytes(12).toString('hex')
        }, d);
        this.base = `https://${this.host}`;
        this.sessions = new Map();   // "ext@domain" -> {userId, token, deviceId}
        this.directory = new Map();  // "ext@domain" -> {until, people: Map(ext -> mxid)}
        this.directRooms = new Map(); // "sender>peerMxid" -> roomId
        this.pending = new Map();    // in-flight group creations by key
        this.txn = 0;
    }

    // ---- guard ----

    /** Throws unless (domain, ext) is a managed demo colleague: never the demo user, never a protected user. */
    assertActor(domain, ext, what) {
        if (ext === this.lab.demoUser.ext && domain === this.lab.demoUser.domain) {
            throw new Error(`Refusing to ${what} the demo user ${ext}@${domain}`);
        }
        assertManaged(this.lab, domain, ext, what);
    }

    isColleague(domain, ext) {
        return !isProtected(this.lab, domain, ext) && managedUsers(this.lab).has(`${domain}/${ext}`)
            && !(ext === this.lab.demoUser.ext && domain === this.lab.demoUser.domain);
    }

    // ---- credentials ----

    async nsJwt(domain, ext) {
        const res = await this.http('POST', `${this.base}/ns-api/v2/jwt`, {
            headers: { authorization: `Bearer ${this.apikey}`, 'content-type': 'application/json', accept: 'application/json' },
            body: { user: ext, domain }
        });
        if (res.status >= 300 || !res.data || !res.data.token) {
            throw new MatrixError(`NS delegated JWT for ${ext}@${domain} failed (HTTP ${res.status})`, res.status);
        }
        return res.data.token;
    }

    async mint(domain, ext) {
        const jwt = await this.nsJwt(domain, ext);
        const res = await this.http('POST', `${this.base}/ns-api/v2/matrix/token`, {
            headers: { authorization: `Bearer ${jwt}`, 'content-type': 'application/json', accept: 'application/json' },
            body: { device_id: deviceId(ext), device_name: DEVICE_NAME }
        });
        if (res.status === 404) {
            throw new MatrixError('Matrix is not available on this core (HTTP 404 from /matrix/token: a v45 core?). Use chatTransport "messagesessions".', 404);
        }
        const d = res.data || {};
        if (res.status >= 300 || !d.user_id || !d.access_token) {
            throw new MatrixError(`Matrix token for ${ext}@${domain} failed (HTTP ${res.status})`, res.status);
        }
        const session = { userId: String(d.user_id), token: String(d.access_token), deviceId: String(d.device_id || deviceId(ext)) };
        this.sessions.set(`${ext}@${domain}`, session);
        return session;
    }

    async session(domain, ext) {
        return this.sessions.get(`${ext}@${domain}`) || this.mint(domain, ext);
    }

    /** Matrix call as (domain, ext). A 401 re-mints once and retries. `ok` lists non-2xx statuses returned instead of thrown. */
    async mx(domain, ext, method, p, body, ok = []) {
        const doCall = async () => {
            const s = await this.session(domain, ext);
            return this.http(method, `${this.base}/_matrix/client/v3${p}`, {
                headers: { authorization: `Bearer ${s.token}`, 'content-type': 'application/json', accept: 'application/json' },
                body
            });
        };
        let res = await doCall();
        if (res.status === 401) {
            this.sessions.delete(`${ext}@${domain}`);
            res = await doCall();
        }
        if (res.status >= 300 && !ok.includes(res.status)) {
            throw new MatrixError(`Matrix ${method} ${p.split('?')[0]} as ${ext}@${domain} failed (HTTP ${res.status})`, res.status);
        }
        return res;
    }

    // ---- people ----

    /** ext -> lowercased Matrix id for the colleagues in `sender`'s contacts (cached DIRECTORY_TTL). */
    async contacts(domain, sender) {
        const key = `${sender}@${domain}`;
        const hit = this.directory.get(key);
        if (hit && hit.until > this.now()) return hit.people;
        const jwt = await this.nsJwt(domain, sender);
        const res = await this.http('GET', `${this.base}/ns-api/v2/domains/${enc(domain)}/users/${enc(sender)}/contacts?includeDomain=yes`, {
            headers: { authorization: `Bearer ${jwt}`, accept: 'application/json' }
        });
        if (res.status >= 300) throw new MatrixError(`contacts for ${sender}@${domain} failed (HTTP ${res.status})`, res.status);
        const people = new Map();
        for (const row of Array.isArray(res.data) ? res.data : []) {
            if (!row || typeof row !== 'object') continue;
            const uid = String(row.uid || '');
            if (!uid) continue; // a colleague row has a uid (ext@domain)
            const [uidUser, , rowDomain] = uid.split(/(@)/);
            const user = String(row.user || uidUser);
            const mxid = mxidOf(row);
            if (user && mxid && (!rowDomain || rowDomain.toLowerCase() === domain.toLowerCase())) people.set(user, mxid);
        }
        this.directory.set(key, { until: this.now() + this.ttlMs, people });
        return people;
    }

    async peerMxid(domain, sender, peer) {
        const mxid = (await this.contacts(domain, sender)).get(peer);
        if (!mxid) throw new MatrixError(`No Matrix id for ${peer}@${domain} in ${sender}'s contacts (has the user ever signed in to chat?)`);
        return mxid;
    }

    // ---- rooms ----

    async accountData(domain, ext, type) {
        const s = await this.session(domain, ext);
        const res = await this.mx(domain, ext, 'GET', `/user/${enc(s.userId)}/account_data/${enc(type)}`, undefined, [404]);
        return res.status === 404 || !res.data || typeof res.data !== 'object' ? {} : res.data;
    }

    /** Append `roomId` under `peerMxid` in `ext`'s m.direct (other entries preserved). */
    async addDirect(domain, ext, peerMxid, roomId) {
        const s = await this.session(domain, ext);
        const direct = await this.accountData(domain, ext, 'm.direct');
        const list = Array.isArray(direct[peerMxid]) ? direct[peerMxid] : [];
        if (list.includes(roomId)) return;
        await this.mx(domain, ext, 'PUT', `/user/${enc(s.userId)}/account_data/m.direct`, { ...direct, [peerMxid]: [...list, roomId] });
    }

    /** JOIN `roomId` as a demo colleague (they never run a client). The demo user is never joined for. */
    async joinAs(domain, ext, roomId) {
        this.assertActor(domain, ext, 'join a room as');
        await this.mx(domain, ext, 'POST', `/join/${enc(roomId)}`, {});
    }

    /** The 1:1 room sender<->peer, Horizon's way. */
    async directRoom(domain, sender, peer) {
        const peerMxid = await this.peerMxid(domain, sender, peer);
        const cacheKey = `${sender}@${domain}>${peerMxid}`;
        if (this.directRooms.has(cacheKey)) return this.directRooms.get(cacheKey);
        const me = await this.session(domain, sender);
        const direct = await this.accountData(domain, sender, 'm.direct');
        const list = Array.isArray(direct[peerMxid]) ? direct[peerMxid] : [];
        let roomId = list.length ? list[list.length - 1] : null;
        if (!roomId) {
            const res = await this.mx(domain, sender, 'POST', '/createRoom', {
                preset: 'trusted_private_chat', invite: [peerMxid], is_direct: true, visibility: 'private'
            });
            roomId = res.data && res.data.room_id;
            if (!roomId) throw new MatrixError('createRoom returned no room id', res.status);
            // Join first: a failed join leaves an orphan room, never a reusable room nobody joined.
            if (this.isColleague(domain, peer)) {
                await this.joinAs(domain, peer, roomId);
                // The colleague's own client would list it; keep their m.direct in step so replies reuse this room.
                await this.addDirect(domain, peer, me.userId, roomId);
            }
            await this.addDirect(domain, sender, peerMxid, roomId);
        }
        this.directRooms.set(cacheKey, roomId);
        return roomId;
    }

    /** The named group room, created once (by `sender`) and remembered. */
    groupRoom(domain, sender, groupName, members, displayName) {
        const key = this.rooms.groupKey(domain, groupName);
        const saved = this.rooms.get(key);
        if (saved) return Promise.resolve(saved);
        if (!this.pending.has(key)) {
            const p = this.createGroup(domain, sender, key, members, displayName || groupName)
                .finally(() => this.pending.delete(key));
            this.pending.set(key, p);
        }
        return this.pending.get(key);
    }

    async createGroup(domain, sender, key, members, name) {
        const others = members.filter(ext => ext !== sender);
        const invite = [];
        for (const ext of others) invite.push(await this.peerMxid(domain, sender, ext));
        const res = await this.mx(domain, sender, 'POST', '/createRoom', {
            name, preset: 'private_chat', visibility: 'private', is_direct: false, invite
        });
        const roomId = res.data && res.data.room_id;
        if (!roomId) throw new MatrixError('createRoom returned no room id', res.status);
        for (const ext of others) if (this.isColleague(domain, ext)) await this.joinAs(domain, ext, roomId);
        return this.rooms.set(key, roomId);
    }

    // ---- send ----

    /**
     * @param {{domain, from, to: string[], group: string|null, groupName?: string, members?: string[]}} m
     * @param {string} text
     */
    async send(m, text) {
        this.assertActor(m.domain, m.from, 'send chat as');
        const roomId = m.group
            ? await this.groupRoom(m.domain, m.from, m.group, m.members || [m.from, ...m.to], m.groupName)
            : await this.directRoom(m.domain, m.from, m.to[0]);
        const txn = `dt${Date.now().toString(36)}${(this.txn++).toString(36)}${this.randomId()}`;
        const res = await this.mx(m.domain, m.from, 'PUT', `/rooms/${enc(roomId)}/send/m.room.message/${txn}`, { msgtype: 'm.text', body: text });
        return { status: res.status, roomId, eventId: res.data && res.data.event_id };
    }
}

module.exports = { MatrixTransport, RoomStore, MatrixError, deviceId, describeStep, defaultHttp, DIRECTORY_TTL_MS };
