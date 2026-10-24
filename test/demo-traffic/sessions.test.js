const fs = require('fs');
const os = require('os');
const path = require('path');
const { SessionStore, newSid, SID_RE, normalizeRemote, remotesOf, findExistingSid } = require('../../demo-traffic/lib/sessions');

describe('sid format', () => {
  test('at least 32 characters, [A-Za-z0-9_] only', () => {
    for (let i = 0; i < 50; i++) {
      const sid = newSid();
      expect(sid.length).toBeGreaterThanOrEqual(32);
      expect(sid).toMatch(/^[A-Za-z0-9_]+$/);
      expect(SID_RE.test(sid)).toBe(true);
    }
  });

  test('is random', () => {
    expect(newSid()).not.toBe(newSid());
  });

  test('SID_RE rejects short or oddly-charactered ids', () => {
    expect(SID_RE.test('short')).toBe(false);
    expect(SID_RE.test('a'.repeat(31))).toBe(false);
    expect(SID_RE.test('a'.repeat(31) + '-')).toBe(false);
    expect(SID_RE.test('a'.repeat(32))).toBe(true);
  });
});

describe('SessionStore', () => {
  let dir;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'demo-traffic-sessions-')); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  test('reuses the sid for the same pair, not for the reverse direction', () => {
    const s = new SessionStore(null, { persist: false });
    const ab = s.get(s.pairKey('d', '4011', '4010'));
    expect(s.get(s.pairKey('d', '4011', '4010'))).toBe(ab);
    expect(s.get(s.pairKey('d', '4010', '4011'))).not.toBe(ab);
    expect(s.get(s.pairKey('d', '4012', '4010'))).not.toBe(ab);
  });

  test('reuses one sid per group, separate groups differ', () => {
    const s = new SessionStore(null, { persist: false });
    const sales = s.get(s.groupKey('d', 'sales'));
    expect(s.get(s.groupKey('d', 'sales'))).toBe(sales);
    expect(s.get(s.groupKey('d', 'support'))).not.toBe(sales);
    expect(SID_RE.test(sales)).toBe(true);
  });

  test('persists to disk and a new store reads the same sids back', () => {
    const file = path.join(dir, 'nested', 'sessions.json');
    const a = new SessionStore(file);
    const sid = a.get(a.pairKey('d', '4011', '4010'));
    expect(fs.existsSync(file)).toBe(true);
    const b = new SessionStore(file);
    expect(b.get(b.pairKey('d', '4011', '4010'))).toBe(sid);
  });

  test('persist:false never writes a file', () => {
    const file = path.join(dir, 'sessions.json');
    const s = new SessionStore(file, { persist: false });
    s.get('k');
    expect(fs.existsSync(file)).toBe(false);
  });

  test('a corrupt file is ignored, and invalid stored sids are dropped', () => {
    const file = path.join(dir, 'sessions.json');
    fs.writeFileSync(file, '{not json');
    expect(new SessionStore(file).map).toEqual({});
    fs.writeFileSync(file, JSON.stringify({ good: 'g'.repeat(40), bad: 'short' }));
    const s = new SessionStore(file);
    expect(s.map).toEqual({ good: 'g'.repeat(40) });
  });
});

describe('number normalisation', () => {
  test('9803510486 == 19803510486 == formatted variants', () => {
    for (const v of ['9803510486', '19803510486', '+1 (980) 351-0486', '1-980-351-0486']) {
      expect(normalizeRemote(v)).toBe('9803510486');
    }
  });

  test('extensions and other lengths are left as digits', () => {
    expect(normalizeRemote('4010')).toBe('4010');
    expect(normalizeRemote('14155550142')).toBe('4155550142');
    expect(normalizeRemote('1234567890')).toBe('1234567890'); // 10 digits starting with 1 is not 11-digit NANP
    expect(normalizeRemote(null)).toBe('');
  });

  test('remotesOf splits lists, normalises and sorts', () => {
    expect(remotesOf('4012, 4010;4011')).toEqual(['4010', '4011', '4012']);
    expect(remotesOf(['19803510486'])).toEqual(['9803510486']);
  });

  test('pair keys treat the two spellings of a number as one conversation', () => {
    const s = new SessionStore(null, { persist: false });
    expect(s.pairKey('d', '5101', '9803510486')).toBe(s.pairKey('d', '5101', '19803510486'));
    expect(s.get(s.pairKey('d', '5101', '9803510486'))).toBe(s.get(s.pairKey('d', '5101', '+1 980 351 0486')));
  });
});

describe('reusing an existing server session', () => {
  const existing = 'e'.repeat(40);
  const list = [
    { 'messagesession-id': 'f'.repeat(40), 'messagesession-remote': '4011' },
    { 'messagesession-id': existing, 'messagesession-remote': '19803510486' }
  ];

  test('findExistingSid matches by normalised remote', () => {
    expect(findExistingSid(list, ['9803510486'])).toBe(existing);
    expect(findExistingSid(list, ['4011'])).toBe('f'.repeat(40));
    expect(findExistingSid(list, ['4999'])).toBeNull();
    expect(findExistingSid({ data: list }, ['9803510486'])).toBe(existing);
    expect(findExistingSid(null, ['9803510486'])).toBeNull();
  });

  test('findExistingSid matches group remotes regardless of order and ignores unusable ids', () => {
    const groups = [
      { 'messagesession-id': 'short', 'messagesession-remote': '4010,4012' },
      { 'messagesession-id': existing, 'messagesession-remote': '4012,4010' }
    ];
    expect(findExistingSid(groups, ['4010', '4012'])).toBe(existing);
  });

  test('resolve reuses the server sid, caches it, and looks up once per key', async () => {
    const s = new SessionStore(null, { persist: false });
    const key = s.pairKey('d', '5101', '9803510486');
    const fetchList = jest.fn(async () => list);
    const r1 = await s.resolve(key, ['9803510486'], fetchList);
    expect(r1).toEqual({ sid: existing, source: 'existing' });
    const r2 = await s.resolve(key, ['9803510486'], fetchList);
    expect(r2.sid).toBe(existing);
    expect(fetchList).toHaveBeenCalledTimes(1);
    expect(s.map[key]).toBe(existing);
  });

  test('resolve mints a sid only when the server has none, then keeps it', async () => {
    const s = new SessionStore(null, { persist: false });
    const key = s.pairKey('d', '5101', '4555');
    const r1 = await s.resolve(key, ['4555'], async () => list);
    expect(r1.source).toBe('new');
    expect(SID_RE.test(r1.sid)).toBe(true);
    const r2 = await s.resolve(key, ['4555'], async () => list);
    expect(r2).toEqual({ sid: r1.sid, source: 'cached' });
  });

  test('a cached sid is replaced by the one the server actually has', async () => {
    const s = new SessionStore(null, { persist: false });
    const key = s.pairKey('d', '5101', '9803510486');
    const minted = s.get(key);
    const r = await s.resolve(key, ['9803510486'], async () => list);
    expect(r.sid).toBe(existing);
    expect(r.sid).not.toBe(minted);
  });

  test('no lookup function (dry run) uses the cached or minted sid and never reaches the server', async () => {
    const s = new SessionStore(null, { persist: false });
    const key = s.pairKey('d', '5101', '9803510486');
    const r = await s.resolve(key, ['9803510486'], null);
    expect(r.source).toBe('new');
    expect((await s.resolve(key, ['9803510486'], null)).sid).toBe(r.sid);
    expect(s.resolved.has(key)).toBe(false);
  });

  test('a failed lookup falls back to the cached sid and retries next time', async () => {
    const s = new SessionStore(null, { persist: false });
    const key = s.pairKey('d', '5101', '9803510486');
    const r = await s.resolve(key, ['9803510486'], async () => { throw new Error('503'); });
    expect(r.source).toBe('lookup-failed');
    const r2 = await s.resolve(key, ['9803510486'], async () => list);
    expect(r2.source).toBe('existing');
  });

  test('set refuses an invalid sid', () => {
    expect(() => new SessionStore(null, { persist: false }).set('k', 'bad sid!')).toThrow(/invalid/);
  });
});
