const fs = require('fs');
const os = require('os');
const path = require('path');
const { MatrixTransport, RoomStore, MatrixError, deviceId, describeStep } = require('../../demo-traffic/lib/matrix');
const { Engine } = require('../../demo-traffic/lib/engine');
const { planStream, chatTransport } = require('../../demo-traffic/lib/streams');
const { freshLab, memStore, collectEvents, makeRng, APIKEY } = require('./helpers');

const HOST = 'ns.example.test';
const DOMAIN = 'sumnersawesomephones';
const mx = ext => `@${ext}-uid:matrix.example.test`;

// A fake NS + Matrix homeserver behind the injected http. Records every call.
function fakeServer({ lab = freshLab(), contacts, tokenStatus = 200, expire401 = 0 } = {}) {
  const calls = [];
  const state = {
    minted: [], direct: {}, rooms: [], joins: [], sent: [], tokens: new Map(), unauthorized: expire401
  };
  const colleagues = ['4010', '4011', '4012', '4013', '4014'];
  const rows = contacts || colleagues.map(ext => ({ uid: `${ext}@${DOMAIN}`, user: ext, 'matrix-user-id': mx(ext).toUpperCase() }));
  const owner = auth => [...state.tokens.entries()].find(([, t]) => `Bearer ${t}` === auth);

  const http = jest.fn(async (method, url, { headers = {}, body } = {}) => {
    const p = url.replace(`https://${HOST}`, '');
    calls.push({ method, p, headers, body });
    if (p === '/ns-api/v2/jwt') return { status: 200, data: { token: `jwt-${body.user}`, refresh: 'r' } };
    if (p === '/ns-api/v2/matrix/token') {
      if (tokenStatus !== 200) return { status: tokenStatus, data: {} };
      const ext = headers.authorization.replace('Bearer jwt-', '');
      const token = `mxtok-${ext}-${state.minted.length}`;
      state.minted.push({ ext, body });
      state.tokens.set(ext, token);
      return { status: 200, data: { user_id: mx(ext), access_token: token, device_id: body.device_id, expires_in_ms: 1 } };
    }
    if (p.startsWith('/ns-api/v2/domains/') && p.includes('/contacts')) return { status: 200, data: rows };
    // Matrix calls: authenticate as whoever holds the bearer token.
    const who = owner(headers.authorization);
    if (!who || state.unauthorized > 0) {
      if (state.unauthorized > 0) state.unauthorized -= 1;
      return { status: 401, data: { errcode: 'M_UNKNOWN_TOKEN' } };
    }
    const ext = who[0];
    const m = p.match(/^\/_matrix\/client\/v3(.*)$/);
    const route = m[1];
    if (route.startsWith('/user/') && route.endsWith('/account_data/m.direct')) {
      if (method === 'GET') return state.direct[ext] ? { status: 200, data: state.direct[ext] } : { status: 404, data: { errcode: 'M_NOT_FOUND' } };
      state.direct[ext] = body;
      return { status: 200, data: {} };
    }
    if (route === '/createRoom') {
      const room = `!room${state.rooms.length}:matrix.example.test`;
      state.rooms.push({ by: ext, room, body });
      return { status: 200, data: { room_id: room } };
    }
    if (route.startsWith('/join/')) {
      state.joins.push({ ext, room: decodeURIComponent(route.slice(6)) });
      return { status: 200, data: {} };
    }
    if (route.startsWith('/rooms/') && route.includes('/send/m.room.message/')) {
      state.sent.push({ ext, room: decodeURIComponent(route.split('/')[2]), txn: route.split('/').pop(), body });
      return { status: 200, data: { event_id: `$ev${state.sent.length}` } };
    }
    return { status: 500, data: {} };
  });
  return { http, calls, state, lab };
}

function transport(server, over = {}) {
  let n = 0;
  return new MatrixTransport({
    host: HOST, apikey: APIKEY, lab: server.lab, http: server.http, randomId: () => `r${n++}`, ...over
  });
}

const direct = (from, to) => ({ domain: DOMAIN, from, to: [to], group: null });
const group = (from, name, members) => ({
  domain: DOMAIN, from, to: members.filter(x => x !== from), group: name, members, groupName: `Team ${name}`
});

describe('credentials', () => {
  test('mints a delegated JWT then a Matrix token with a stable per-identity device id', async () => {
    const s = fakeServer();
    await transport(s).send(direct('4014', '4010'), 'hi');
    const jwt = s.calls.find(c => c.p === '/ns-api/v2/jwt');
    expect(jwt.headers.authorization).toBe(`Bearer ${APIKEY}`);
    expect(jwt.body).toEqual({ user: '4014', domain: DOMAIN });
    expect(s.state.minted[0]).toMatchObject({ ext: '4014', body: { device_id: 'DEMOTRAFFIC4014', device_name: 'demo-traffic' } });
    expect(deviceId('4014')).toBe('DEMOTRAFFIC4014');
  });

  test('the Matrix token is cached per sender: two sends mint once', async () => {
    const s = fakeServer();
    const t = transport(s);
    await t.send(direct('4014', '4010'), 'one');
    await t.send(direct('4014', '4010'), 'two');
    expect(s.state.minted).toHaveLength(1);
    await t.send(direct('4013', '4010'), 'other sender');
    expect(s.state.minted.map(m => m.ext)).toEqual(['4014', '4013']);
  });

  test('a Matrix 401 re-mints once and retries; a second 401 is an error', async () => {
    const s = fakeServer();
    const t = transport(s);
    await t.send(direct('4014', '4010'), 'warm');
    s.state.tokens.delete('4014'); // the server no longer knows the cached token
    s.state.minted.length = 0;
    const r = await t.send(direct('4014', '4010'), 'after expiry');
    expect(r.status).toBe(200);
    expect(s.state.minted).toHaveLength(1);

    const stuck = fakeServer({ expire401: 99 });
    await expect(transport(stuck).send(direct('4014', '4010'), 'x')).rejects.toMatchObject({ status: 401 });
    // one mint, one retry mint: never a loop
    expect(stuck.state.minted.length).toBeLessThanOrEqual(2);
  });

  test('404 from /matrix/token is a clear v45 error', async () => {
    const s = fakeServer({ tokenStatus: 404 });
    const err = await transport(s).send(direct('4014', '4010'), 'hi').catch(e => e);
    expect(err).toBeInstanceOf(MatrixError);
    expect(err.status).toBe(404);
    expect(err.message).toMatch(/not available on this core.*messagesessions/);
  });

  test('tokens and the apikey never appear in errors', async () => {
    const s = fakeServer({ tokenStatus: 500 });
    const err = await transport(s).send(direct('4014', '4010'), 'hi').catch(e => e);
    expect(err.message).not.toContain(APIKEY);
    expect(err.message).not.toMatch(/jwt-|mxtok/);
  });
});

describe('peer Matrix ids', () => {
  test('come from the sender contacts, lowercased, and are cached for the TTL', async () => {
    const s = fakeServer();
    let now = 1000;
    const t = transport(s, { now: () => now, ttlMs: 60000 });
    expect(await t.peerMxid(DOMAIN, '4014', '4010')).toBe(mx('4010'));
    await t.peerMxid(DOMAIN, '4014', '4011');
    const contactCalls = () => s.calls.filter(c => c.p.includes('/contacts')).length;
    expect(contactCalls()).toBe(1);
    expect(s.calls.find(c => c.p.includes('/contacts')).p).toBe(`/ns-api/v2/domains/${DOMAIN}/users/4014/contacts?includeDomain=yes`);
    now += 61000;
    await t.peerMxid(DOMAIN, '4014', '4011');
    expect(contactCalls()).toBe(2);
  });

  test('a peer missing from contacts is a clear error and nothing is created', async () => {
    const s = fakeServer({ contacts: [{ uid: `4011@${DOMAIN}`, user: '4011', 'matrix-user-id': mx('4011') }] });
    await expect(transport(s).send(direct('4014', '4010'), 'hi')).rejects.toThrow(/No Matrix id for 4010/);
    expect(s.state.rooms).toHaveLength(0);
  });

  test('a contact without a matrix-user-id is treated as missing', async () => {
    const s = fakeServer({ contacts: [{ uid: `4010@${DOMAIN}`, user: '4010' }] });
    await expect(transport(s).peerMxid(DOMAIN, '4014', '4010')).rejects.toThrow(/No Matrix id/);
  });
});

describe('1:1 rooms', () => {
  test('creates a Horizon-style direct room and records it in m.direct', async () => {
    const s = fakeServer();
    const r = await transport(s).send(direct('4014', '4010'), 'hello');
    expect(s.state.rooms).toHaveLength(1);
    expect(s.state.rooms[0].body).toEqual({
      preset: 'trusted_private_chat', invite: [mx('4010')], is_direct: true, visibility: 'private'
    });
    expect(s.state.direct['4014']).toEqual({ [mx('4010')]: [r.roomId] });
    expect(s.state.sent[0]).toMatchObject({ ext: '4014', room: r.roomId, body: { msgtype: 'm.text', body: 'hello' } });
  });

  test('reuses the LAST room listed for the peer in m.direct, creating nothing', async () => {
    const s = fakeServer();
    s.state.tokens.set('4014', 'preset');
    // seed 4014's m.direct with two rooms for 4010 and an unrelated peer
    s.state.direct['4014'] = { [mx('4010')]: ['!old:x', '!newest:x'], [mx('4012')]: ['!other:x'] };
    const r = await transport(s).send(direct('4014', '4010'), 'hello');
    expect(r.roomId).toBe('!newest:x');
    expect(s.state.rooms).toHaveLength(0);
    expect(s.calls.some(c => c.method === 'PUT' && c.p.endsWith('/account_data/m.direct'))).toBe(false);
  });

  test('creating a room PUTs m.direct preserving every other entry', async () => {
    const s = fakeServer();
    s.state.tokens.set('4014', 'preset');
    s.state.direct['4014'] = { [mx('4012')]: ['!other:x'] };
    const r = await transport(s).send(direct('4014', '4010'), 'hello');
    expect(s.state.direct['4014']).toEqual({ [mx('4012')]: ['!other:x'], [mx('4010')]: [r.roomId] });
  });

  test('a burst reuses the same room and uses a unique txn id per message', async () => {
    const s = fakeServer();
    const t = transport(s);
    for (const text of ['a', 'b', 'c']) await t.send(direct('4014', '4010'), text);
    expect(s.state.rooms).toHaveLength(1);
    expect(new Set(s.state.sent.map(m => m.room)).size).toBe(1);
    expect(new Set(s.state.sent.map(m => m.txn)).size).toBe(3);
  });

  test('a demo colleague peer is joined as themselves and gets the room in their own m.direct', async () => {
    const s = fakeServer();
    const r = await transport(s).send(direct('4011', '4012'), 'hey');
    expect(s.state.joins).toEqual([{ ext: '4012', room: r.roomId }]);
    expect(s.state.direct['4012']).toEqual({ [mx('4011')]: [r.roomId] });
    expect(s.state.direct['4011']).toEqual({ [mx('4012')]: [r.roomId] });
  });

  test('the demo user as peer is invited but never joined for', async () => {
    const s = fakeServer();
    await transport(s).send(direct('4014', '4010'), 'hey');
    expect(s.state.joins).toEqual([]);
    expect(s.state.minted.map(m => m.ext)).not.toContain('4010');
    expect(Object.keys(s.state.direct)).not.toContain('4010');
  });
});

describe('group rooms', () => {
  const members = ['4011', '4012', '4013'];

  test('created once by the first sender with everyone else invited, then reused', async () => {
    const s = fakeServer();
    const t = transport(s);
    const first = await t.send(group('4011', 'sales', members), 'morning');
    const second = await t.send(group('4012', 'sales', members), 'hi');
    expect(s.state.rooms).toHaveLength(1);
    expect(s.state.rooms[0].body).toEqual({
      name: 'Team sales', preset: 'private_chat', visibility: 'private', is_direct: false,
      invite: [mx('4012'), mx('4013')]
    });
    expect(second.roomId).toBe(first.roomId);
    expect(s.state.sent.map(m => m.ext)).toEqual(['4011', '4012']);
  });

  test('invited colleagues are joined as themselves; the demo user is never a member or actor', async () => {
    const s = fakeServer();
    const r = await transport(s).send(group('4011', 'sales', members), 'morning');
    expect(s.state.joins).toEqual([{ ext: '4012', room: r.roomId }, { ext: '4013', room: r.roomId }]);
    expect(s.state.minted.map(m => m.ext)).not.toContain('4010');
  });

  test('concurrent first sends create the room only once', async () => {
    const s = fakeServer();
    const t = transport(s);
    await Promise.all([t.send(group('4011', 'sales', members), 'a'), t.send(group('4012', 'sales', members), 'b')]);
    expect(s.state.rooms).toHaveLength(1);
  });

  test('the room id is persisted per group name and reused by a new transport', async () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'mxrooms-')), 'matrix-rooms.json');
    const s = fakeServer();
    const first = await transport(s, { rooms: new RoomStore(file) }).send(group('4011', 'sales', members), 'a');
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({ [`group:${DOMAIN}:sales`]: first.roomId });

    const s2 = fakeServer();
    const again = await transport(s2, { rooms: new RoomStore(file) }).send(group('4012', 'sales', members), 'b');
    expect(again.roomId).toBe(first.roomId);
    expect(s2.state.rooms).toHaveLength(0);
  });

  test('a failed create persists nothing', async () => {
    const s = fakeServer({ contacts: [] });
    const rooms = new RoomStore(null, { persist: false });
    await expect(transport(s, { rooms }).send(group('4011', 'sales', members), 'a')).rejects.toThrow(/No Matrix id/);
    expect(rooms.get(rooms.groupKey(DOMAIN, 'sales'))).toBeNull();
  });
});

describe('safety guards', () => {
  test('never sends as the demo user', async () => {
    const s = fakeServer();
    await expect(transport(s).send(direct('4010', '4011'), 'x')).rejects.toThrow(/demo user/);
    expect(s.http).not.toHaveBeenCalled();
  });

  test('never sends as a protected or unmanaged user (including the onecloud-sbz admins)', async () => {
    const s = fakeServer();
    const t = transport(s);
    await expect(t.send({ domain: DOMAIN, from: '1001', to: ['4011'], group: null }, 'x')).rejects.toThrow();
    await expect(t.send({ domain: 'onecloud-sbz', from: '1005', to: ['5101'], group: null }, 'x')).rejects.toThrow();
    await expect(t.send({ domain: DOMAIN, from: '4999', to: ['4011'], group: null }, 'x')).rejects.toThrow();
    expect(s.http).not.toHaveBeenCalled();
  });

  test('joinAs refuses the demo user and protected users', async () => {
    const t = transport(fakeServer());
    await expect(t.joinAs(DOMAIN, '4010', '!r:x')).rejects.toThrow(/demo user/);
    await expect(t.joinAs(DOMAIN, '1001', '!r:x')).rejects.toThrow();
  });
});

describe('transport selection', () => {
  const ctx = lab => ({ lab, rng: makeRng('mx'), sessions: memStore(), timeScale: 1, busy: new Set() });

  test('the committed lab.json uses Matrix for chat', () => {
    const lab = freshLab({ chatTransport: undefined });
    delete lab.chatTransport;
    const committed = JSON.parse(fs.readFileSync(path.join(__dirname, '../../demo-traffic/lab.json'), 'utf8'));
    expect(committed.chatTransport).toBe('matrix');
    expect(committed.streams.chatToDemo).toMatchObject({ enabled: true, ratePerHour: 3 });
    expect(chatTransport(lab)).toBe('messagesessions'); // absent means messagesessions
  });

  test('rejects an unknown transport', () => {
    expect(() => chatTransport({ chatTransport: 'xmpp' })).toThrow(/chatTransport/);
  });

  test.each(['chatToDemo', 'chatCrossTalk', 'groupChat'])('%s plans Matrix steps with no messagesession', name => {
    const plan = planStream(name, ctx(freshLab({ chatTransport: 'matrix' })));
    expect(plan.steps.length).toBeGreaterThan(0);
    for (const step of plan.steps) {
      expect(step.transport).toBe('matrix');
      expect(step.sid).toBeUndefined();
      expect(step.path).toBeUndefined();
      expect(step.matrix.from).toBe(step.user);
      expect(step.matrix.from).not.toBe('4010');
    }
    if (name === 'chatToDemo') expect(plan.steps.every(s => s.matrix.to[0] === '4010')).toBe(true);
    if (name === 'groupChat') {
      for (const step of plan.steps) {
        expect(step.matrix.members).not.toContain('4010');
        expect(step.matrix.groupName).toMatch(/Team|Everyone/);
      }
    }
  });

  test.each(['chatToDemo', 'chatCrossTalk', 'groupChat'])('%s keeps messagesessions when lab.json says so', name => {
    const plan = planStream(name, ctx(freshLab({ chatTransport: 'messagesessions' })));
    for (const step of plan.steps) {
      expect(step.transport).toBeUndefined();
      expect(step.path).toMatch(/messagesessions/);
    }
  });

  test('SMS never uses Matrix', () => {
    const lab = freshLab({ chatTransport: 'matrix' });
    const plan = planStream('sms', ctx(lab));
    expect(plan.kind === 'skip' || plan.steps.every(s => s.transport !== 'matrix')).toBe(true);
  });
});

describe('engine with the Matrix transport', () => {
  function engineWith(over) {
    const ev = collectEvents();
    const e = new Engine({
      lab: freshLab({ chatTransport: 'matrix' }), rng: makeRng('eng-mx'), sessions: memStore(), events: ev,
      clock: { now: () => Date.parse('2026-10-26T14:00:00Z') }, wait: async () => {}, ...over
    });
    return { e, ev };
  }

  test('a live step is handed to the transport and logs the room, not a messagesession', async () => {
    const matrix = { send: jest.fn(async () => ({ status: 200, roomId: '!r:x', eventId: '$e' })) };
    const api = { apiPostJson: jest.fn(), apiGet: jest.fn() };
    const { e, ev } = engineWith({ matrix, api });
    await e.fire('chatCrossTalk');
    expect(matrix.send).toHaveBeenCalled();
    expect(api.apiPostJson).not.toHaveBeenCalled();
    expect(api.apiGet).not.toHaveBeenCalled();
    expect(ev.lines.filter(l => l.action === 'message-sent').every(l => l.room === '!r:x')).toBe(true);
  });

  test('a transport failure is logged as message-failed without throwing', async () => {
    const matrix = { send: jest.fn(async () => { throw new MatrixError('boom', 500); }) };
    const { e, ev } = engineWith({ matrix });
    await e.fire('chatToDemo');
    expect(ev.lines.some(l => l.action === 'message-failed' && /boom/.test(l.error))).toBe(true);
  });

  test('a dry run is offline: no transport, no api, planned Matrix steps in the log', async () => {
    const matrix = { send: jest.fn() };
    const api = { apiPostJson: jest.fn(), apiGet: jest.fn() };
    const { e, ev } = engineWith({ matrix, api, dryRun: true });
    await e.fire('groupChat');
    expect(matrix.send).not.toHaveBeenCalled();
    expect(api.apiPostJson).not.toHaveBeenCalled();
    const dry = ev.lines.filter(l => l.action === 'message-dry-run');
    expect(dry.length).toBeGreaterThan(0);
    for (const l of dry) {
      expect(l.request).toMatch(/^MATRIX /);
      expect(l.request).toMatch(/group "/);
      expect(l.request).toContain('PUT /rooms/{room}/send/m.room.message/{txn}');
      expect(JSON.stringify(l)).not.toMatch(/Bearer|mxtok-|jwt-[0-9]/);
    }
  });

  test('describeStep for a 1:1 names the reuse-or-create convention', () => {
    const line = describeStep({ domain: DOMAIN, from: '4014', to: ['4010'], group: null });
    expect(line).toMatch(/4014@sumnersawesomephones/);
    expect(line).toMatch(/m\.direct/);
    expect(line).toMatch(/trusted_private_chat/);
  });
});
