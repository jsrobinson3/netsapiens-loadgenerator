// Message bank for demo-traffic. Every entry is a "thread": 1-4 turns that
// read as one conversation, so a burst (2-4 messages a few seconds apart)
// looks like a person typing, not four unrelated lines.
//
//   who: "a" is the sender that opened the conversation, "b" the other party
//        (cross-talk and group threads). One-sided banks (toDemo, sms, inbox)
//        only use "a".
//   dept: "Sales" | "Support" restricts a thread to senders of that department
//        (omit for anyone).  groups: restricts a group thread to those group
//        names (omit for any group).
//   "{demo}" is replaced with the demo user's first name.
//
// Selection is seeded (lib/agent-sim/rng), so a seed reproduces the same run.

//   when: optional time tags. A thread without `when` is always eligible.
//        Tags are evaluated in lab.timeZone (see timeTags): morning (before
//        11:30), midday (11:30-14:00), afternoon (14:00 on), eod (16:00 on),
//        weekday, friday, weekend. Period tags and day tags are ANDed (any one
//        of each group), so ['morning', 'weekday'] = weekday mornings. On a
//        weekend only untagged and "weekend"-tagged threads (with no period
//        tag) are eligible.

const t = (who, text) => ({ who, text });

// Colleague -> demo user (all turns from the colleague).
const toDemo = [
    { dept: 'Sales', when: ['morning', 'midday'], turns: [t('a', 'Hey {demo}, got a minute to look at the Halvorsen quote before 3?'), t('a', 'They want the 24-month term with the install bundled in'), t('a', 'I can send you the draft, just say when')] },
    { dept: 'Sales', when: ['weekday'], turns: [t('a', 'Brightline Dental just signed the renewal')] },
    { dept: 'Sales', when: ['morning', 'midday'], turns: [t('a', '{demo}, can you jump on a call with Ortega Freight at 2:30? They have questions on porting'), t('a', 'I will send the invite now')] },
    { dept: 'Sales', when: ['weekday'], turns: [t('a', 'Pipeline review moved to Thursday 10am')] },
    { dept: 'Sales', when: ['midday', 'afternoon'], turns: [t('a', 'Did the Becker HVAC proposal go out yet?'), t('a', 'They emailed twice this morning asking for pricing on 12 more seats')] },
    { dept: 'Sales', when: ['weekday'], turns: [t('a', 'Quick one: are we discounting the desk phones for the Stein & Park deal?'), t('a', 'They are comparing us with the other vendor and it is close')] },
    { dept: 'Sales', when: ['morning', 'weekday'], turns: [t('a', 'Great demo yesterday, the softphone part landed really well')] },
    { dept: 'Sales', when: ['morning', 'midday'], turns: [t('a', 'Reminder: forecast numbers are due by end of day')] },
    { dept: 'Support', when: ['weekday'], turns: [t('a', '{demo}, escalating a ticket: caller ID is showing the wrong name on outbound calls for one customer'), t('a', 'I already checked the user profile, it looks right'), t('a', 'Can you look at the domain settings when you get a chance?')] },
    { dept: 'Support', when: ['midday', 'afternoon'], turns: [t('a', 'Heads up, a customer is reporting choppy audio on calls since this morning'), t('a', 'Only on Wi-Fi so far, wired seems fine')] },
    { dept: 'Support', when: ['weekday'], turns: [t('a', 'Voicemail to email is not delivering for the front desk line'), t('a', 'I resent the test twice, nothing in spam either')] },
    { dept: 'Support', when: ['weekday'], turns: [t('a', 'Can you approve the number port for Ortega Freight? The carrier is waiting on us')] },
    { dept: 'Support', when: ['weekday'], turns: [t('a', 'Customer asked if we support call recording on the basic plan, what should I tell them?')] },
    { dept: 'Support', when: ['midday', 'afternoon'], turns: [t('a', 'Closed 9 tickets so far today, queue is looking calm')] },
    { dept: 'Support', when: ['weekday'], turns: [t('a', '{demo}, the HubSpot softphone is not showing presence for one of our users'), t('a', 'Logging out and back in did not help')] },
    { when: ['morning', 'weekday'], turns: [t('a', 'Morning {demo}! Coffee run, want anything?')] },
    { when: ['weekend'], turns: [t('a', 'Hey {demo}, sorry to bug you on a weekend. A customer escalation just came in on the support line'), t('a', 'Nothing urgent, take a look when you can')] },
    { when: ['weekend'], turns: [t('a', 'Heads up, I am covering on-call today, ping me if anything comes up')] },
    { when: ['weekend'], turns: [t('a', 'Hope you are having a good weekend {demo}!')] },
    { when: ['eod'], turns: [t('a', 'Heading out for the day, anything you need from me before I go?')] },
    { when: ['eod', 'weekday'], turns: [t('a', 'Wrapping up, I will send the recap first thing tomorrow')] },
    { when: ['morning', 'midday', 'weekday'], turns: [t('a', 'Can we push our 1:1 to 4pm? Something came up with a customer')] },
    { when: ['morning', 'weekday'], turns: [t('a', 'Lunch at 12:30? The taco place by the office'), t('a', 'Priya and Jordan are in too')] },
    { when: ['weekday'], turns: [t('a', 'Sent you the notes from the customer call, shout if I missed anything')] },
    { when: ['weekday'], turns: [t('a', 'Do you have the slides from last week all-hands? Can not find them in the drive')] },
    { when: ['afternoon'], turns: [t('a', 'Thanks for covering for me earlier, I owe you one')] },
    { when: ['morning', 'midday', 'weekday'], turns: [t('a', '{demo}, are you free for 10 minutes to walk through the new onboarding checklist?'), t('a', 'No rush, anytime this afternoon works')] }
];

// Colleague <-> colleague (a opens, b answers, a closes).
const crossTalk = [
    { dept: 'Sales', when: ['weekday'], turns: [t('a', 'Did Halvorsen reply about the quote?'), t('b', 'Not yet, I will ping them after lunch'), t('a', 'Cool, loop me in if they push back on price')] },
    { dept: 'Sales', when: ['morning', 'midday', 'weekday'], turns: [t('a', 'Can you cover my 2pm demo? I have a dentist appointment'), t('b', 'Sure, send me the deck'), t('a', 'Thanks, you are a lifesaver')] },
    { dept: 'Sales', when: ['weekday'], turns: [t('a', 'Which seat count did Becker HVAC ask for?'), t('b', '12 more, so 25 total')] },
    { dept: 'Support', when: ['midday', 'afternoon'], turns: [t('a', 'Is the audio issue from this morning resolved?'), t('b', 'Looks like it, the customer moved off the guest Wi-Fi'), t('a', 'Great, closing the ticket then')] },
    { dept: 'Support', when: ['weekday'], turns: [t('a', 'I need a second pair of eyes on a porting ticket'), t('b', 'Send me the number and I will check the carrier status')] },
    { dept: 'Support', when: ['weekday', 'friday'], turns: [t('a', 'Who is on call this weekend?'), t('b', 'Jordan has Saturday, I have Sunday')] },
    { when: ['morning', 'weekday'], turns: [t('a', 'Want to grab lunch?'), t('b', 'Yes! 12:30 works'), t('a', 'Perfect, meet at the front')] },
    { when: ['weekday'], turns: [t('a', 'Did you see the announcement about the holiday schedule?'), t('b', 'Just read it, we get the Friday off')] },
    { when: ['morning', 'midday', 'weekday'], turns: [t('a', 'Is the conference room free at 3?'), t('b', 'Booked until 3:30 sorry, try the small one')] },
    { when: ['weekday'], turns: [t('a', 'Do you have the customer list handy?'), t('b', 'Sharing the sheet now'), t('a', 'Got it, thanks')] },
    { when: ['weekday'], turns: [t('a', 'My headset died, anyone have a spare?'), t('b', 'Check the supply cabinet, top shelf')] },
    { when: ['weekend'], turns: [t('a', 'Anyone else getting pages from the on-call phone?'), t('b', 'Nothing here, probably a blip')] },
    { when: ['eod'], turns: [t('a', 'Heading out, anything you need before I go?'), t('b', 'All good, have a great evening')] },
    { when: ['friday'], turns: [t('a', 'Happy Friday!'), t('b', 'Same to you, almost there')] }
];

// Group chats. Speakers a/b are two different members (never the demo user).
const group = [
    { groups: ['sales', 'all'], when: ['weekday'], turns: [t('a', 'Win of the week: Brightline Dental renewed for 3 years'), t('b', 'Nice work!'), t('a', 'Team effort, thanks for the intro')] },
    { groups: ['sales'], when: ['weekday'], turns: [t('a', 'Reminder: pricing sheet updated, use the new version for quotes'), t('b', 'Got it, deleting the old one')] },
    { groups: ['sales'], when: ['morning', 'weekday'], turns: [t('a', 'Anyone free to join a prospect call at 11?'), t('b', 'I can, send the details')] },
    { groups: ['support', 'all'], when: ['weekday'], turns: [t('a', 'Queue is at 6 waiting, can someone jump in?'), t('b', 'On it'), t('a', 'Thanks!')] },
    { groups: ['support'], when: ['weekday'], turns: [t('a', 'New known issue: voicemail email delay for one customer, engineering is on it'), t('b', 'Adding it to the status page notes')] },
    { groups: ['support'], when: ['weekday'], turns: [t('a', 'Who handled the Stein & Park ticket yesterday?'), t('b', 'That was me, happy to share the notes')] },
    { groups: ['all'], when: ['weekday'], turns: [t('a', 'Team lunch on Thursday, I am collecting orders'), t('b', 'Count me in for the burrito bowl')] },
    { groups: ['all'], when: ['morning', 'midday', 'weekday'], turns: [t('a', 'Fire drill at 2pm today, heads up'), t('b', 'Thanks for the warning')] },
    { groups: ['all'], when: ['weekday'], turns: [t('a', 'Reminder to submit your timesheets by 5pm Friday')] },
    { groups: ['all'], when: ['weekday'], turns: [t('a', 'The printer on the second floor is out of toner again'), t('b', 'I left a spare cartridge by the supply cabinet')] },
    { when: ['weekend'], turns: [t('a', 'Weekend on-call reminder: check the status page before you log off'), t('b', 'Will do')] },
    { when: ['eod'], turns: [t('a', 'Signing off for the day, have a good evening all'), t('b', 'See you tomorrow')] },
    { when: ['morning', 'weekday'], turns: [t('a', 'Good morning team'), t('b', 'Morning!')] },
    { when: ['weekday'], turns: [t('a', 'Anyone seeing slowness on the portal right now?'), t('b', 'Fine for me'), t('a', 'OK, probably just my connection')] }
];

// Customers texting the demo number (one-sided).
const sms = [
    { when: ['morning', 'midday'], turns: [t('a', 'Hi, this is Kim from Brightline Dental. Can someone call me back about our invoice?'), t('a', 'Anytime after 1pm is good')] },
    { turns: [t('a', 'Is my order ready for pickup?')] },
    { turns: [t('a', 'Hello, Luis from Ortega Freight. Our new numbers are not working yet'), t('a', 'Can you check the port status?')] },
    { when: ['midday', 'afternoon'], turns: [t('a', 'Thanks for the quick help earlier!')] },
    { when: ['afternoon', 'weekday'], turns: [t('a', 'Rachel at Stein & Park here. Do you have availability tomorrow morning for a quick call?'), t('a', 'Preferably before 10')] },
    { turns: [t('a', 'Tom Becker, we need two more desk phones. Who should I talk to?')] },
    { turns: [t('a', 'Confirming our appointment for Thursday at 3pm')] },
    { turns: [t('a', 'Sorry, wrong number. Please disregard')] }
];

// Customers texting the shared inbox number (one-sided).
const inbox = [
    { turns: [t('a', 'Hi, I would like to get a quote for 8 phone lines'), t('a', 'We are a small law office, moving next month')] },
    { when: ['morning', 'midday', 'weekday'], turns: [t('a', 'Our front desk phone has no dial tone this morning')] },
    { when: ['weekday'], turns: [t('a', 'Can you tell me your support hours?')] },
    { turns: [t('a', 'I got a voicemail from this number, who is calling?')] },
    { turns: [t('a', 'Please send me a copy of last month invoice'), t('a', 'The accounting email is billing@example.com')] },
    { turns: [t('a', 'Interested in the softphone app, is there a trial?')] }
];

const BANKS = { toDemo, crossTalk, group, sms, inbox };

const { wallClock } = require('../lib/agent-sim/time');

/**
 * Time tags that hold at an instant in `timeZone`.
 *   weekend -> ['weekend']
 *   weekday -> ['weekday', morning|midday|afternoon, (eod from 16:00), (friday)]
 * Outside business hours the nearest period applies (before 08:00 is
 * "morning", after 18:00 is "afternoon" + "eod").
 */
function timeTags(epochMs, timeZone) {
    const w = wallClock(epochMs, timeZone);
    if (w.dow === 'Sat' || w.dow === 'Sun') return ['weekend'];
    const tags = ['weekday'];
    const m = w.minuteOfDay;
    tags.push(m < 11 * 60 + 30 ? 'morning' : m < 14 * 60 ? 'midday' : 'afternoon');
    if (m >= 16 * 60) tags.push('eod');
    if (w.dow === 'Fri') tags.push('friday');
    return tags;
}

const PERIOD_TAGS = ['morning', 'midday', 'afternoon', 'eod'];
const DAY_TAGS = ['weekday', 'friday', 'weekend'];

/**
 * Untagged threads are always eligible. Tags come in two groups, period
 * (morning/midday/afternoon/eod) and day (weekday/friday/weekend). A thread
 * needs ANY of its period tags to hold (if it has some) AND ANY of its day tags
 * to hold (if it has some), so ['morning', 'weekday'] means weekday mornings.
 * null `tags` means no filtering.
 */
function eligibleAt(thread, tags) {
    if (!tags || !thread.when || !thread.when.length) return true;
    const group = names => {
        const mine = thread.when.filter(x => names.includes(x));
        return !mine.length || mine.some(x => tags.includes(x));
    };
    return group(PERIOD_TAGS) && group(DAY_TAGS);
}

function fill(text, vars) {
    return text.replace(/\{(\w+)\}/g, (m, k) => (vars && vars[k] !== undefined ? vars[k] : m));
}

/**
 * Pick one conversation from a bank.
 * @param rng    lib/agent-sim rng
 * @param kind   'toDemo' | 'crossTalk' | 'group' | 'sms' | 'inbox'
 * @param opts   { burst: bool, turns: [min,max], dept, group, vars,
 *                 at: epoch ms (omit for no time filtering), timeZone }
 * @returns {{turns: {who,text}[], dept, burst}}  burst=true returns 2+ turns
 *          when the thread has them; otherwise only the opening turn.
 */
function pickConversation(rng, kind, opts = {}) {
    const bank = BANKS[kind];
    if (!bank) throw new Error(`Unknown message bank "${kind}"`);
    const tags = opts.at !== undefined && opts.timeZone ? timeTags(opts.at, opts.timeZone) : null;
    let pool = bank.filter(th =>
        (!th.dept || !opts.dept || th.dept === opts.dept) &&
        (!th.groups || !opts.group || th.groups.includes(opts.group)) &&
        eligibleAt(th, tags));
    if (!pool.length) pool = bank.filter(th => !th.dept && !th.groups && eligibleAt(th, tags));
    if (!pool.length) pool = bank.filter(th => !th.when); // always-eligible threads
    if (!pool.length) pool = bank;
    let turns;
    let burst = false;
    if (opts.burst) {
        const multi = pool.filter(th => th.turns.length >= 2);
        if (multi.length) {
            const th = rng.pick(multi);
            const [lo, hi] = opts.turns || [2, 4];
            const n = Math.min(th.turns.length, rng.int(Math.max(2, lo), Math.max(2, hi)));
            turns = th.turns.slice(0, n);
            burst = true;
        }
    }
    if (!turns) turns = [rng.pick(pool).turns[0]];
    return {
        turns: turns.map(x => ({ who: x.who, text: fill(x.text, opts.vars) })),
        burst
    };
}

module.exports = { BANKS, pickConversation, fill, timeTags, eligibleAt };
