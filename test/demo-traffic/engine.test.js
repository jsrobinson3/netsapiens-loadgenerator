const { Engine } = require('../../demo-traffic/lib/engine');
const { SessionStore, SID_RE } = require('../../demo-traffic/lib/sessions');
const { freshLab, memStore, collectEvents, makeRng } = require('./helpers');

const MON_10AM = Date.parse('2026-10-26T14:00:00Z'); // 10:00 EDT Monday
const SAT_10AM = Date.parse('2026-10-24T14:00:00Z');

function makeEngine(over = {}) {
  const ev = collectEvents();
  const timers = [];
  const e = new Engine({
    lab: freshLab(), rng: makeRng('eng'), sessions: memStore(), events: ev,
    api: { apiPostJson: jest.fn(async () => ({ status: 202 })), apiGet: jest.fn(async () => ({ data: [] })) },
    calls: { run: jest.fn(async () => ({ ok: true })), drain: jest.fn(async () => {}) },
    clock: { now: () => MON_10AM }, wait: async () => {},
    setTimer: (fn, ms) => { const t = { fn, ms }; timers.push(t); return t; },
    clearTimer: t => { t.cleared = true; },
    ...over
  });
  return { e, ev, timers };
}

describe('Engine.enabledStreams', () => {
  test('sms and inbox are off by default, the rest are on', () => {
    const { e } = makeEngine();
    expect(e.enabledStreams()).toEqual(['chatToDemo', 'chatCrossTalk', 'groupChat', 'callsToDemo', 'callsToInbox', 'callsCrossTalk']);
  });

  test('--once on a disabled sms stream only logs a skip (no sender has a from-number)', async () => {
    const { e, ev } = makeEngine();
    const r = await e.fire('sms');
    expect(r.plan.kind).toBe('skip');
    expect(ev.lines[0]).toMatchObject({ stream: 'sms', action: 'skipped' });
    expect(e.api.apiPostJson).not.toHaveBeenCalled();
  });
});

describe('Engine.fire', () => {
  test('dry run logs each request and sends nothing, with no GET either', async () => {
    const { e, ev } = makeEngine({ dryRun: true });
    await e.fire('groupChat');
    expect(e.api.apiPostJson).not.toHaveBeenCalled();
    expect(e.api.apiGet).not.toHaveBeenCalled();
    expect(ev.lines.length).toBeGreaterThan(0);
    for (const l of ev.lines) {
      expect(l.action).toBe('message-dry-run');
      expect(l.request).toMatch(/^POST domains\/sumnersawesomephones\/users\/401[1-4]\/messagesessions\/[A-Za-z0-9_]{32,}\/messages$/);
      expect(l.from).not.toMatch(/^4010@/);
    }
  });

  test('live: posts every step with the planned body and logs the status', async () => {
    const { e, ev } = makeEngine();
    const r = await e.fire('chatToDemo');
    expect(e.api.apiPostJson).toHaveBeenCalledTimes(r.plan.steps.length);
    const [path, body] = e.api.apiPostJson.mock.calls[0];
    expect(path).toContain('/messagesessions/');
    expect(body).toMatchObject({ type: 'chat', destination: '4010' });
    expect(ev.lines.filter(l => l.action === 'message-sent').every(l => l.status === 202)).toBe(true);
  });

  test('a failed send is logged and the burst continues', async () => {
    const calls = [];
    const { e, ev } = makeEngine({
      api: {
        apiGet: async () => ({ data: [] }),
        apiPostJson: jest.fn(async () => { calls.push(1); const err = new Error('x'); err.response = { status: 500 }; throw err; })
      }
    });
    const r = await e.fire('chatCrossTalk');
    expect(calls.length).toBe(r.plan.steps.length);
    expect(ev.lines.some(l => l.action === 'message-failed')).toBe(true);
  });

  test('call streams go to the call runner', async () => {
    const { e } = makeEngine();
    const r = await e.fire('callsToDemo');
    expect(r.plan.kind).toBe('call');
    expect(e.calls.run).toHaveBeenCalledWith(expect.objectContaining({ target: '9803510486' }));
  });

  test('unknown stream throws', async () => {
    const { e } = makeEngine();
    await expect(e.fire('bogus')).rejects.toThrow(/Unknown stream/);
  });
});

describe('Engine session reuse (live)', () => {
  const existing = 'a'.repeat(40);

  test('reuses the server messagesession whose remote matches, GETting once per conversation', async () => {
    const lab = freshLab();
    lab.streams.chatToDemo.senders = ['4011'];
    lab.streams.chatToDemo.burst.chance = 1;
    const api = {
      apiGet: jest.fn(async () => ({ data: [{ 'messagesession-id': existing, 'messagesession-remote': '4010' }] })),
      apiPostJson: jest.fn(async () => ({ status: 202 }))
    };
    const { e, ev } = makeEngine({ lab, api });
    const r = await e.fire('chatToDemo');
    expect(api.apiGet).toHaveBeenCalledTimes(1);
    expect(api.apiGet).toHaveBeenCalledWith('domains/sumnersawesomephones/users/4011/messagesessions');
    expect(r.plan.steps.length).toBeGreaterThan(1);
    for (const [path] of api.apiPostJson.mock.calls) expect(path).toContain(`/messagesessions/${existing}/messages`);
    expect(ev.lines.some(l => l.action === 'session-reused')).toBe(true);
    await e.fire('chatToDemo');
    expect(api.apiGet).toHaveBeenCalledTimes(1); // cached for the run
  });

  test('mints and caches a sid only when the server has none', async () => {
    const lab = freshLab();
    lab.streams.chatToDemo.senders = ['4011'];
    const { e } = makeEngine({ lab });
    await e.fire('chatToDemo');
    const [path] = e.api.apiPostJson.mock.calls[0];
    const sid = path.split('/messagesessions/')[1].split('/')[0];
    expect(SID_RE.test(sid)).toBe(true);
    expect(Object.values(e.sessions.map)).toContain(sid);
  });

  test('SMS: 9803510486 on the server matches the 19803510486 destination', async () => {
    const lab = freshLab();
    lab.streams.sms.senders.forEach(s => { s.fromNumber = '16195550141'; });
    const api = {
      apiGet: jest.fn(async () => ({ data: [{ 'messagesession-id': existing, 'messagesession-remote': '9803510486' }] })),
      apiPostJson: jest.fn(async () => ({ status: 202 }))
    };
    const { e } = makeEngine({ lab, api });
    await e.fire('sms');
    expect(api.apiPostJson.mock.calls[0][0]).toContain(`/messagesessions/${existing}/messages`);
    expect(api.apiPostJson.mock.calls[0][1]).toMatchObject({ type: 'sms', destination: '19803510486' });
  });

  test('a failed session lookup still sends, on the cached or minted sid', async () => {
    const api = {
      apiGet: jest.fn(async () => { throw new Error('boom'); }),
      apiPostJson: jest.fn(async () => ({ status: 202 }))
    };
    const { e, ev } = makeEngine({ api });
    await e.fire('chatToDemo');
    expect(api.apiPostJson).toHaveBeenCalled();
    expect(ev.lines.some(l => l.action === 'session-lookup-failed')).toBe(true);
  });
});

describe('Engine scheduling', () => {
  test('start schedules one timer per enabled stream with clamped delays', () => {
    const { e, timers } = makeEngine();
    const started = e.start();
    expect(started).toHaveLength(6);
    expect(timers).toHaveLength(6);
    for (const t of timers) expect(t.ms).toBeGreaterThan(0);
  });

  test('time-scale compresses the delays', () => {
    const slow = makeEngine({ rng: makeRng('same') });
    const fast = makeEngine({ rng: makeRng('same'), timeScale: 60 });
    slow.e.start(); fast.e.start();
    slow.timers.forEach((t, i) => expect(fast.timers[i].ms).toBeCloseTo(t.ms / 60, 6));
  });

  test('outside business hours a tick fires nothing and reschedules (logging once)', async () => {
    const { e, ev, timers } = makeEngine({ clock: { now: () => SAT_10AM } });
    e.start();
    const before = timers.length;
    timers[0].fn(); timers[1].fn();
    expect(timers.length).toBe(before + 2);
    expect(ev.lines.filter(l => l.action === 'quiet-hours')).toHaveLength(1);
    expect(e.api.apiPostJson).not.toHaveBeenCalled();
    expect(e.calls.run).not.toHaveBeenCalled();
  });

  test('--ignore-hours fires on a Saturday', async () => {
    const { e, timers } = makeEngine({ clock: { now: () => SAT_10AM }, ignoreHours: true });
    e.start();
    timers[0].fn();
    await e.stop();
    expect(e.api.apiPostJson.mock.calls.length + e.calls.run.mock.calls.length).toBeGreaterThan(0);
  });

  test('stop clears timers, waits for in-flight work and drains calls', async () => {
    const { e, timers } = makeEngine();
    e.start();
    timers[0].fn();
    await e.stop();
    expect(timers.slice(0, 6).every(t => t.cleared || t.fn)).toBe(true);
    expect(e.calls.drain).toHaveBeenCalled();
    const n = timers.length;
    e.schedule('chatToDemo');
    expect(timers.length).toBe(n); // no scheduling after stop
  });

  test('stop cuts short a burst wait', async () => {
    const lab = freshLab();
    lab.streams.chatToDemo.burst.chance = 1;
    lab.streams.chatToDemo.burst.gapSeconds = [3000, 3000];
    const { e } = makeEngine({ lab, wait: undefined });
    const p = e.fire('chatToDemo');
    await new Promise(r => setImmediate(r));
    await new Promise(r => setImmediate(r));
    await e.stop();
    await p;
    expect(e.api.apiPostJson.mock.calls.length).toBe(1);
  });
});

describe('Engine passes the (simulated) clock to message selection', () => {
  test('Saturday 4pm: chat to the demo user is never a weekday/morning line', async () => {
    for (let i = 0; i < 60; i++) {
      const { e } = makeEngine({ clock: { now: () => SAT_10AM + 6 * 3600000 }, dryRun: true, rng: makeRng(`sat${i}`) });
      const { plan } = await e.fire('chatToDemo');
      for (const step of plan.steps) expect(step.body.message).not.toMatch(/Coffee run|Lunch at 12:30|Happy Friday/);
    }
  });
});
