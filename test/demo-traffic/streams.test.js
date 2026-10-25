const { planStream, ALL_STREAMS, toE164Digits, messagePath } = require('../../demo-traffic/lib/streams');
const { validateLab, loadLab } = require('../../demo-traffic/lib/lab');
const { SID_RE } = require('../../demo-traffic/lib/sessions');
const { BANKS } = require('../../demo-traffic/messages');
const { freshLab, memStore, makeRng } = require('./helpers');

const plan = (name, seed, extra = {}) => {
  const lab = extra.lab || freshLab();
  return planStream(name, { lab, rng: makeRng(seed), sessions: extra.sessions || memStore(), ...extra, lab });
};

describe('message bank', () => {
  test('has 60+ turns and multi-turn threads', () => {
    const turns = Object.values(BANKS).flat().reduce((n, th) => n + th.turns.length, 0);
    expect(turns).toBeGreaterThanOrEqual(60);
    expect(Object.values(BANKS).flat().some(th => th.turns.length >= 3)).toBe(true);
  });
});

describe('chatToDemo / chatCrossTalk', () => {
  test('always sends from a managed home user to the demo user, never as 4010', () => {
    for (let i = 0; i < 300; i++) {
      const p = plan('chatToDemo', `s${i}`);
      expect(p.kind).toBe('messages');
      for (const s of p.steps) {
        expect(s.user).not.toBe('4010');
        expect(['4011', '4012', '4013', '4014']).toContain(s.user);
        expect(s.body.destination).toBe('4010');
        expect(s.body.type).toBe('chat');
        expect(s.path).toBe(messagePath('sumnersawesomephones', s.user, s.sid));
        expect(SID_RE.test(s.sid)).toBe(true);
      }
    }
  });

  test('cross-talk never involves 4010 and replies flip direction on one pair', () => {
    for (let i = 0; i < 200; i++) {
      const p = plan('chatCrossTalk', `x${i}`);
      for (const s of p.steps) {
        expect(s.user).not.toBe('4010');
        expect(s.body.destination).not.toBe('4010');
        expect(s.body.destination).not.toBe(s.user);
      }
    }
  });

  test('reuses the sid for the same sender and recipient across events', () => {
    const sessions = memStore();
    const lab = freshLab();
    lab.streams.chatToDemo.senders = ['4011'];
    const a = plan('chatToDemo', 1, { lab, sessions });
    const b = plan('chatToDemo', 2, { lab, sessions });
    expect(new Set([...a.steps, ...b.steps].map(s => s.sid)).size).toBe(1);
  });

  test('burst steps are spaced by delays, first at 0', () => {
    let burst = null;
    for (let i = 0; i < 200 && !burst; i++) {
      const p = plan('chatToDemo', `b${i}`);
      if (p.steps.length > 1) burst = p;
    }
    expect(burst).not.toBeNull();
    expect(burst.steps[0].delayMs).toBe(0);
    for (let i = 1; i < burst.steps.length; i++) {
      expect(burst.steps[i].delayMs).toBeGreaterThan(burst.steps[i - 1].delayMs);
    }
  });

  test('time-scale shortens burst gaps', () => {
    const a = plan('chatToDemo', 'ts', { timeScale: 1 });
    const b = plan('chatToDemo', 'ts', { timeScale: 100 });
    expect(a.steps.length).toBe(b.steps.length);
    if (a.steps.length > 1) expect(b.steps[1].delayMs).toBeLessThan(a.steps[1].delayMs);
  });
});

describe('groupChat', () => {
  test('never sends as 4010, destination is the other members, one sid per group', () => {
    const lab = freshLab();
    const sessions = memStore();
    const sidByGroup = {};
    for (let i = 0; i < 300; i++) {
      const p = plan('groupChat', `g${i}`, { lab, sessions });
      expect(p.kind).toBe('messages');
      for (const s of p.steps) {
        expect(s.user).not.toBe('4010');
        expect(Array.isArray(s.body.destination)).toBe(true);
        expect(s.body.destination).not.toContain(s.user);
        const members = lab.groups[p.group];
        expect([...s.body.destination, s.user].sort()).toEqual([...members].sort());
        sidByGroup[p.group] = sidByGroup[p.group] || s.sid;
        expect(s.sid).toBe(sidByGroup[p.group]);
        expect(SID_RE.test(s.sid)).toBe(true);
      }
    }
    expect(Object.keys(sidByGroup).length).toBeGreaterThan(1);
  });

  test('a group of only the demo user yields a skip, not a send as 4010', () => {
    const lab = freshLab();
    lab.groups.solo = ['4010'];
    lab.streams.groupChat.groups = ['solo'];
    const p = plan('groupChat', 1, { lab });
    expect(p.kind).toBe('skip');
  });

  test('a group containing an unmanaged sender is refused', () => {
    const lab = freshLab();
    lab.groups.bad = ['4010', '9999'];
    lab.streams.groupChat.groups = ['bad'];
    expect(() => plan('groupChat', 1, { lab })).toThrow(/not listed in lab.json create.users/);
  });
});

describe('allowDemoUserReplies', () => {
  test('lab.json ships it false', () => {
    expect(loadLab().options.allowDemoUserReplies).toBe(false);
  });

  test('turning it on is rejected by validation', () => {
    const lab = freshLab();
    lab.options.allowDemoUserReplies = true;
    expect(() => validateLab(lab)).toThrow(/allowDemoUserReplies/);
  });

  test('no stream ever sends as 4010 across every message stream and many seeds', () => {
    const lab = freshLab();
    for (const name of ALL_STREAMS) {
      for (let i = 0; i < 100; i++) {
        const p = plan(name, `${name}${i}`, { lab });
        if (p.kind === 'messages') p.steps.forEach(s => expect(s.user).not.toBe('4010'));
        if (p.kind === 'call') expect(p.caller.ext).not.toBe('4010');
      }
    }
  });
});

describe('sms and inbox streams', () => {
  test('are disabled by default in lab.json', () => {
    const lab = freshLab();
    expect(lab.streams.sms.enabled).toBe(false);
    expect(lab.streams.inbox.enabled).toBe(false);
  });

  test('plan a skip while no sender has a from-number / the inbox has no number', () => {
    expect(plan('sms', 1)).toMatchObject({ kind: 'skip', stream: 'sms' });
    expect(plan('inbox', 1)).toMatchObject({ kind: 'skip', stream: 'inbox' }); // senders have no fromNumber
    const lab = freshLab();
    lab.streams.inbox.senders.forEach(s => { s.fromNumber = '16195550141'; });
    lab.streams.inbox.inboxNumber = null;
    expect(plan('inbox', 1, { lab })).toMatchObject({ kind: 'skip', stream: 'inbox' });
  });

  test('the Support Inbox number is configured and SMS to it uses the 11-digit form', () => {
    const lab = freshLab();
    expect(lab.streams.inbox.inboxNumber).toBe('9803510485');
    lab.streams.inbox.senders.forEach(s => { s.fromNumber = '16195550141'; });
    const p = plan('inbox', 2, { lab });
    expect(p.kind).toBe('messages');
    expect(p.steps[0].body).toMatchObject({ type: 'sms', destination: '19803510485' });
  });

  test('once configured, build the documented SMS payload', () => {
    const lab = freshLab();
    lab.streams.sms.senders.forEach(s => { s.fromNumber = '(619) 555-0141'; });
    const p = plan('sms', 3, { lab });
    expect(p.kind).toBe('messages');
    expect(p.steps[0].body).toMatchObject({ type: 'sms', destination: '19803510486', 'from-number': '16195550141' });
    expect(p.steps[0].domain).toBe('onecloud-sbz');
  });

  test('toE164Digits prefixes 10-digit numbers', () => {
    expect(toE164Digits('980-351-0486')).toBe('19803510486');
    expect(toE164Digits('19803510486')).toBe('19803510486');
  });
});

describe('call plans', () => {
  test('callsToDemo dials the demo DID from a partner caller', () => {
    for (let i = 0; i < 50; i++) {
      const p = plan('callsToDemo', `c${i}`);
      expect(p).toMatchObject({ kind: 'call', target: '9803510486' });
      expect(['5101', '5102', '5103', '5104']).toContain(p.caller.ext);
      expect(p.talkMs).toBeGreaterThanOrEqual(20000);
      expect(p.talkMs).toBeLessThanOrEqual(120000);
    }
  });

  test('callsCrossTalk never calls itself, and skips busy extensions', () => {
    const busy = new Set(['4011', '4012']);
    for (let i = 0; i < 100; i++) {
      const p = plan('callsCrossTalk', `k${i}`, { busy });
      expect(p.kind).toBe('call');
      expect(['4013', '4014']).toContain(p.caller.ext);
      expect(p.target).not.toBe(p.caller.ext);
      expect(busy.has(p.target)).toBe(false);
    }
  });

  test('with no free callee the stream skips unless it rolls a call to the demo user', () => {
    const busy = new Set(['4011', '4012', '4013']);
    const kinds = new Set();
    for (let i = 0; i < 100; i++) {
      const p = plan('callsCrossTalk', `z${i}`, { busy });
      kinds.add(p.kind);
      if (p.kind === 'call') expect(p.target).toBe('4010');
    }
    expect(kinds.has('skip')).toBe(true);
  });

  test('all callers busy => skip', () => {
    const busy = new Set(['5101', '5102', '5103', '5104']);
    expect(plan('callsToDemo', 1, { busy })).toMatchObject({ kind: 'skip' });
  });

  test('a busy demo user is not called a second time', () => {
    expect(plan('callsToDemo', 1, { busy: new Set(['4010']) })).toMatchObject({ kind: 'skip' });
  });
});

describe('callsToInbox', () => {
  test('is enabled and dials the Support Inbox DID (10 digits) from a partner device at ~1/hr', () => {
    const lab = freshLab();
    expect(lab.streams.callsToInbox.enabled).toBe(true);
    expect(lab.streams.callsToInbox.ratePerHour).toBe(1);
    for (let i = 0; i < 20; i++) {
      const p = plan('callsToInbox', `i${i}`, { lab });
      expect(p.kind).toBe('call');
      expect(p.target).toBe('9803510485');
      expect(p.caller.domain).toBe('onecloud-sbz');
      expect(['5101', '5102', '5103', '5104']).toContain(p.caller.ext);
    }
  });

  test('never targets protected extensions directly (no 2000 extension dial)', () => {
    for (let i = 0; i < 20; i++) expect(plan('callsToInbox', i).target).not.toBe('2000');
  });

  test('skips when the inbox number is unset, the inbox is busy, or all callers are busy', () => {
    const lab = freshLab();
    lab.streams.inbox.inboxNumber = null;
    expect(plan('callsToInbox', 1, { lab })).toMatchObject({ kind: 'skip', stream: 'callsToInbox' });
    expect(plan('callsToInbox', 1, { busy: new Set(['9803510485']) })).toMatchObject({ kind: 'skip' });
    expect(plan('callsToInbox', 1, { busy: new Set(['5101', '5102', '5103', '5104']) })).toMatchObject({ kind: 'skip' });
  });
});

test('unknown stream names are rejected', () => {
  expect(() => plan('nope', 1)).toThrow(/Unknown stream/);
});
