const { BANKS, pickConversation, timeTags, eligibleAt } = require('../../demo-traffic/messages');
const { planStream } = require('../../demo-traffic/lib/streams');
const { freshLab, memStore, makeRng } = require('./helpers');

const TZ = 'America/New_York';
// 2026-10-24 is a Saturday, 2026-10-26 a Monday, 2026-10-30 a Friday (EDT = UTC-4).
const at = (iso) => Date.parse(iso);
const SAT_4PM = at('2026-10-24T20:00:00Z');
const MON_9AM = at('2026-10-26T13:00:00Z');
const MON_NOON = at('2026-10-26T16:00:00Z');
const MON_3PM = at('2026-10-26T19:00:00Z');
const MON_5PM = at('2026-10-26T21:00:00Z');
const FRI_5PM = at('2026-10-30T21:00:00Z');

const allTexts = (kind, opts, seeds = 150) => {
  const seen = new Set();
  for (let i = 0; i < seeds; i++) {
    const rng = makeRng(`${kind}-${i}`);
    for (const burst of [false, true]) {
      pickConversation(rng, kind, { burst, timeZone: TZ, ...opts }).turns.forEach(t => seen.add(t.text));
    }
  }
  return seen;
};

describe('timeTags', () => {
  test('weekday periods in the lab time zone', () => {
    expect(timeTags(MON_9AM, TZ)).toEqual(['weekday', 'morning']);
    expect(timeTags(MON_NOON, TZ)).toEqual(['weekday', 'midday']);
    expect(timeTags(MON_3PM, TZ)).toEqual(['weekday', 'afternoon']);
    expect(timeTags(MON_5PM, TZ)).toEqual(['weekday', 'afternoon', 'eod']);
    expect(timeTags(FRI_5PM, TZ)).toEqual(['weekday', 'afternoon', 'eod', 'friday']);
  });

  test('weekend is only weekend', () => {
    expect(timeTags(SAT_4PM, TZ)).toEqual(['weekend']);
    expect(timeTags(at('2026-10-25T15:00:00Z'), TZ)).toEqual(['weekend']); // Sunday
  });

  test('uses the zone, not UTC (Friday 9pm ET is already Saturday UTC)', () => {
    expect(timeTags(at('2026-10-31T01:00:00Z'), TZ)).toContain('friday');
    expect(timeTags(at('2026-10-31T01:00:00Z'), 'UTC')).toEqual(['weekend']);
  });
});

describe('eligibleAt', () => {
  test('untagged threads are always eligible; tagged need any matching tag', () => {
    expect(eligibleAt({ turns: [] }, ['weekend'])).toBe(true);
    expect(eligibleAt({ when: [], turns: [] }, ['weekend'])).toBe(true);
    expect(eligibleAt({ when: ['morning', 'midday'] }, ['weekday', 'midday'])).toBe(true);
    expect(eligibleAt({ when: ['morning'] }, ['weekday', 'afternoon'])).toBe(false);
    expect(eligibleAt({ when: ['weekday'] }, ['weekend'])).toBe(false);
  });

  test('period and day tags are ANDed: weekday mornings are not weekday afternoons', () => {
    const wdMorning = { when: ['morning', 'weekday'] };
    expect(eligibleAt(wdMorning, ['weekday', 'morning'])).toBe(true);
    expect(eligibleAt(wdMorning, ['weekday', 'afternoon'])).toBe(false);
    expect(eligibleAt(wdMorning, ['weekend'])).toBe(false);
    expect(eligibleAt({ when: ['eod', 'weekday'] }, ['weekday', 'afternoon', 'eod'])).toBe(true);
    expect(eligibleAt({ when: ['friday'] }, ['weekday', 'morning'])).toBe(false);
    expect(eligibleAt({ when: ['weekend'] }, ['weekend'])).toBe(true);
  });

  test('null tags means no filtering', () => {
    expect(eligibleAt({ when: ['morning'] }, null)).toBe(true);
  });
});

describe('pickConversation time filter', () => {
  test('the bank tags the time-specific threads', () => {
    const coffee = BANKS.toDemo.find(th => th.turns[0].text.startsWith('Morning {demo}! Coffee run'));
    expect(coffee.when).toEqual(expect.arrayContaining(['morning']));
    expect(coffee.when).not.toContain('afternoon');
  });

  test('"Coffee run" never goes out in the afternoon or at the weekend, but does in the morning', () => {
    for (const [when, expected] of [[SAT_4PM, false], [MON_3PM, false], [MON_NOON, false], [MON_9AM, true]]) {
      const texts = [...allTexts('toDemo', { at: when, vars: { demo: 'Sumner' } })];
      expect(texts.some(x => x.includes('Coffee run'))).toBe(expected);
    }
  });

  test('weekend: no weekday-flavoured text from any bank, for any department or group', () => {
    const banned = /Coffee run|Lunch at 12:30|Happy Friday|timesheets|Fire drill|Team lunch|Queue is at 6|Closed 9 tickets|Good morning team|Pipeline review|Win of the week/;
    const cases = [
      ['toDemo', { dept: 'Sales' }], ['toDemo', { dept: 'Support' }], ['toDemo', {}],
      ['crossTalk', { dept: 'Sales' }], ['crossTalk', { dept: 'Support' }], ['crossTalk', { dept: 'none' }],
      ['group', { group: 'sales' }], ['group', { group: 'support' }], ['group', { group: 'all' }],
      ['sms', {}], ['inbox', {}]
    ];
    for (const [kind, o] of cases) {
      for (const text of allTexts(kind, { ...o, at: SAT_4PM })) expect(text).not.toMatch(banned);
    }
  });

  test('every bank/department/time combination still yields a conversation', () => {
    const times = [SAT_4PM, MON_9AM, MON_NOON, MON_3PM, MON_5PM, FRI_5PM];
    for (const when of times) {
      for (const [kind, o] of [['toDemo', { dept: 'Sales' }], ['toDemo', { dept: 'Support' }], ['crossTalk', { dept: 'none' }], ['crossTalk', { dept: 'Sales' }], ['group', { group: 'sales' }], ['group', { group: 'all' }], ['sms', {}], ['inbox', {}]]) {
        for (const burst of [false, true]) {
          const c = pickConversation(makeRng(`${kind}-${when}`), kind, { ...o, burst, at: when, timeZone: TZ });
          expect(c.turns.length).toBeGreaterThan(0);
        }
      }
    }
  });

  test('weekend-tagged threads only appear on weekends; "Happy Friday" only on Friday', () => {
    expect([...allTexts('toDemo', { at: MON_9AM })].some(x => /on a weekend|covering on-call today|good weekend/.test(x))).toBe(false);
    expect([...allTexts('toDemo', { at: SAT_4PM })].some(x => /on a weekend|covering on-call today|good weekend/.test(x))).toBe(true);
    expect([...allTexts('crossTalk', { at: MON_3PM, dept: 'none' })].some(x => x.includes('Happy Friday'))).toBe(false);
    expect([...allTexts('crossTalk', { at: FRI_5PM, dept: 'none' })].some(x => x.includes('Happy Friday'))).toBe(true);
  });

  test('without at/timeZone nothing is filtered (deterministic for callers with no clock)', () => {
    const texts = new Set();
    for (let i = 0; i < 200; i++) pickConversation(makeRng(i), 'toDemo', { vars: { demo: 'Sumner' } }).turns.forEach(t => texts.add(t.text));
    expect([...texts].some(x => x.includes('Coffee run'))).toBe(true);
  });

  test('seeded selection stays reproducible at a fixed time', () => {
    const a = pickConversation(makeRng(7), 'toDemo', { at: MON_9AM, timeZone: TZ, burst: true });
    const b = pickConversation(makeRng(7), 'toDemo', { at: MON_9AM, timeZone: TZ, burst: true });
    expect(a).toEqual(b);
  });
});

describe('streams pass the clock to the picker', () => {
  test('chatToDemo planned at Saturday 4pm ET never says "Coffee run"', () => {
    for (let i = 0; i < 120; i++) {
      const lab = freshLab();
      const p = planStream('chatToDemo', { lab, rng: makeRng(`s${i}`), sessions: memStore(), now: SAT_4PM });
      for (const step of p.steps) expect(step.body.message).not.toMatch(/Coffee run|Lunch at 12:30/);
    }
  });
});
