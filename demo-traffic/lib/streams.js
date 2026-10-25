// Turns a stream name into a concrete plan (who sends what to whom, or who
// calls whom). Pure given the rng/session store: nothing here touches the
// network, so every stream is unit-testable. run.js executes the plans.

const { pickConversation } = require('../messages');
const { scaledMs } = require('./schedule');
const { assertManaged, userByExt } = require('./lab');

const enc = encodeURIComponent;
const MESSAGE_STREAMS = ['chatToDemo', 'chatCrossTalk', 'groupChat', 'sms', 'inbox'];
const CALL_STREAMS = ['callsToDemo', 'callsToInbox', 'callsCrossTalk'];
const ALL_STREAMS = [...MESSAGE_STREAMS, ...CALL_STREAMS];

/** Chat transport from lab.json: "matrix" (v46) or "messagesessions" (default). Only chat streams use it; SMS never does. */
function chatTransport(lab) {
    const t = lab.chatTransport || 'messagesessions';
    if (t !== 'matrix' && t !== 'messagesessions') throw new Error(`lab.json chatTransport must be "matrix" or "messagesessions", got "${t}"`);
    return t;
}

function messagePath(domain, user, sid) {
    return `domains/${enc(domain)}/users/${enc(user)}/messagesessions/${sid}/messages`;
}

/** 10-digit US number -> 11 digits with the leading 1 (what the SMS API expects). */
function toE164Digits(number) {
    const d = String(number || '').replace(/\D/g, '');
    return d.length === 10 ? `1${d}` : d;
}

// Gap list for a burst: delays (real ms) of each message after the event fires.
function burstDelays(rng, count, cfg, timeScale) {
    const gaps = cfg.burst?.gapSeconds || [5, 40];
    const delays = [0];
    let acc = 0;
    for (let i = 1; i < count; i++) {
        acc += scaledMs(rng.range(gaps) * 1000, timeScale);
        delays.push(Math.round(acc));
    }
    return delays;
}

function buildSteps(ctx, cfg, conv, make) {
    const delays = burstDelays(ctx.rng, conv.turns.length, cfg, ctx.timeScale);
    return conv.turns.map((turn, i) => ({ delayMs: delays[i], ...make(turn, i) }));
}

function wantsBurst(ctx, cfg) {
    return ctx.rng.chance(cfg.burst?.chance ?? 0);
}

function demoVars(lab) {
    return { demo: lab.demoUser.firstName || 'there' };
}

// Time-of-day inputs for message selection (omitted when the caller gave no clock).
function whenOpts(ctx) {
    return ctx.now === undefined ? {} : { at: ctx.now, timeZone: ctx.lab.timeZone };
}

// A chat step sent through Matrix (v46): no messagesession id, the engine hands
// `matrix` to the Matrix transport. `body` is kept for logging only.
function matrixStep(lab, from, to, group, text, members) {
    return {
        transport: 'matrix', domain: lab.homeDomain, user: from, type: 'chat', to: to.join(','),
        matrix: {
            domain: lab.homeDomain, from, to, group,
            ...(group ? { members, groupName: (lab.groupNames && lab.groupNames[group]) || group } : {})
        },
        body: { type: 'chat', message: text, destination: group ? to : to[0] }
    };
}

function chatToDemo(ctx) {
    const { lab, rng, sessions } = ctx;
    const cfg = lab.streams.chatToDemo;
    const demo = lab.demoUser;
    const sender = rng.pick(cfg.senders);
    assertManaged(lab, lab.homeDomain, sender, 'send chat as');
    const user = userByExt(lab, lab.homeDomain, sender);
    const conv = pickConversation(rng, 'toDemo', {
        burst: wantsBurst(ctx, cfg), turns: cfg.burst?.messages, dept: user.department, vars: demoVars(lab), ...whenOpts(ctx)
    });
    if (chatTransport(lab) === 'matrix') {
        return {
            kind: 'messages', stream: 'chatToDemo', burst: conv.burst,
            steps: buildSteps(ctx, cfg, conv, turn => matrixStep(lab, sender, [demo.ext], null, turn.text))
        };
    }
    const sid = sessions.get(sessions.pairKey(lab.homeDomain, sender, demo.ext));
    return {
        kind: 'messages', stream: 'chatToDemo', burst: conv.burst,
        steps: buildSteps(ctx, cfg, conv, turn => ({
            domain: lab.homeDomain, user: sender, sid, type: 'chat', to: demo.ext,
            key: sessions.pairKey(lab.homeDomain, sender, demo.ext), remotes: [demo.ext],
            path: messagePath(lab.homeDomain, sender, sid),
            body: { type: 'chat', message: turn.text, destination: demo.ext }
        }))
    };
}

function chatCrossTalk(ctx) {
    const { lab, rng, sessions } = ctx;
    const cfg = lab.streams.chatCrossTalk;
    const [a, b] = rng.shuffle(cfg.participants).slice(0, 2);
    assertManaged(lab, lab.homeDomain, a, 'send chat as');
    assertManaged(lab, lab.homeDomain, b, 'send chat as');
    const ua = userByExt(lab, lab.homeDomain, a);
    const ub = userByExt(lab, lab.homeDomain, b);
    const conv = pickConversation(rng, 'crossTalk', {
        burst: wantsBurst(ctx, cfg), turns: cfg.burst?.messages,
        dept: ua.department === ub.department ? ua.department : 'none', vars: demoVars(lab), ...whenOpts(ctx)
    });
    const viaMatrix = chatTransport(lab) === 'matrix';
    return {
        kind: 'messages', stream: 'chatCrossTalk', burst: conv.burst,
        steps: buildSteps(ctx, cfg, conv, turn => {
            const from = turn.who === 'a' ? a : b;
            const to = turn.who === 'a' ? b : a;
            if (viaMatrix) return matrixStep(lab, from, [to], null, turn.text);
            const sid = sessions.get(sessions.pairKey(lab.homeDomain, from, to));
            return {
                domain: lab.homeDomain, user: from, sid, type: 'chat', to,
                key: sessions.pairKey(lab.homeDomain, from, to), remotes: [to],
                path: messagePath(lab.homeDomain, from, sid),
                body: { type: 'chat', message: turn.text, destination: to }
            };
        })
    };
}

function groupChat(ctx) {
    const { lab, rng, sessions } = ctx;
    const cfg = lab.streams.groupChat;
    const name = rng.pick(cfg.groups);
    const members = lab.groups[name];
    if (!members) throw new Error(`groupChat: unknown group "${name}" (see lab.json groups)`);
    // Never send as the demo user, nor as anyone demo-traffic does not manage.
    const senders = members.filter(ext => ext !== lab.demoUser.ext);
    for (const s of senders) assertManaged(lab, lab.homeDomain, s, 'send group chat as');
    if (senders.length < 1) return { kind: 'skip', stream: 'groupChat', reason: `group ${name} has no eligible sender` };
    const [a, b] = rng.shuffle(senders);
    const speakerB = b || a;
    const conv = pickConversation(rng, 'group', {
        burst: wantsBurst(ctx, cfg), turns: cfg.burst?.messages, group: name, vars: demoVars(lab), ...whenOpts(ctx)
    });
    const viaMatrix = chatTransport(lab) === 'matrix';
    const sid = viaMatrix ? null : sessions.get(sessions.groupKey(lab.homeDomain, name));
    return {
        kind: 'messages', stream: 'groupChat', burst: conv.burst, group: name,
        steps: buildSteps(ctx, cfg, conv, turn => {
            const from = turn.who === 'a' ? a : speakerB;
            const to = members.filter(ext => ext !== from);
            if (viaMatrix) return matrixStep(lab, from, to, name, turn.text, members);
            return {
                domain: lab.homeDomain, user: from, sid, type: 'chat', to: to.join(','),
                key: sessions.groupKey(lab.homeDomain, name), remotes: to,
                path: messagePath(lab.homeDomain, from, sid),
                body: { type: 'chat', message: turn.text, destination: to }
            };
        })
    };
}

// SMS-like streams: partner users text a number (the demo DID or the shared inbox).
function smsLike(ctx, stream, bankKind, destination) {
    const { lab, rng, sessions } = ctx;
    const cfg = lab.streams[stream];
    const senders = (cfg.senders || []).filter(s => s.fromNumber);
    if (!senders.length) {
        return { kind: 'skip', stream, reason: 'no sender has a fromNumber (set one in lab.json streams.' + stream + '.senders)' };
    }
    const s = rng.pick(senders);
    assertManaged(lab, s.domain, s.user, 'send SMS as');
    const conv = pickConversation(rng, bankKind, { burst: wantsBurst(ctx, cfg), turns: cfg.burst?.messages, vars: demoVars(lab), ...whenOpts(ctx) });
    const sid = sessions.get(sessions.pairKey(s.domain, s.user, destination));
    return {
        kind: 'messages', stream, burst: conv.burst,
        steps: buildSteps(ctx, cfg, conv, turn => ({
            domain: s.domain, user: s.user, sid, type: 'sms', to: destination,
            key: sessions.pairKey(s.domain, s.user, destination), remotes: [destination],
            path: messagePath(s.domain, s.user, sid),
            body: { type: 'sms', message: turn.text, destination, 'from-number': toE164Digits(s.fromNumber) }
        }))
    };
}

function sms(ctx) {
    return smsLike(ctx, 'sms', 'sms', toE164Digits(ctx.lab.demoUser.did));
}

function inbox(ctx) {
    const number = ctx.lab.streams.inbox.inboxNumber;
    if (!number) {
        return { kind: 'skip', stream: 'inbox', reason: 'inboxNumber is not set in lab.json (the shared inbox has no SMS number yet)' };
    }
    return smsLike(ctx, 'inbox', 'inbox', toE164Digits(number));
}

function pickCallers(ctx, cfg) {
    const busy = ctx.busy || new Set();
    return cfg.callers.filter(ext => !busy.has(ext));
}

function callPlan(ctx, stream, callerExt, target, targetLabel, cfg) {
    const { lab, rng } = ctx;
    const user = lab.create.users.find(u => u.ext === callerExt);
    if (!user) throw new Error(`${stream}: caller ${callerExt} is not in create.users`);
    assertManaged(lab, user.domain, user.ext, 'place a call as');
    return {
        kind: 'call', stream, caller: user, target, targetLabel,
        audio: rng.pick(cfg.audio), talkMs: Math.round(rng.range(cfg.talkSeconds) * 1000)
    };
}

function callsToDemo(ctx) {
    const { lab, rng } = ctx;
    const cfg = lab.streams.callsToDemo;
    if ((ctx.busy || new Set()).has(lab.demoUser.ext)) return { kind: 'skip', stream: 'callsToDemo', reason: 'demo user already has a demo call in progress' };
    const callers = pickCallers(ctx, cfg);
    if (!callers.length) return { kind: 'skip', stream: 'callsToDemo', reason: 'all callers busy' };
    return callPlan(ctx, 'callsToDemo', rng.pick(callers), lab.demoUser.did, `${lab.demoUser.ext} (via ${lab.demoUser.did})`, cfg);
}

function callsToInbox(ctx) {
    const { lab, rng } = ctx;
    const cfg = lab.streams.callsToInbox;
    const number = lab.streams.inbox && lab.streams.inbox.inboxNumber;
    if (!number) return { kind: 'skip', stream: 'callsToInbox', reason: 'inbox.inboxNumber is not set in lab.json' };
    const callers = pickCallers(ctx, cfg);
    if (!callers.length) return { kind: 'skip', stream: 'callsToInbox', reason: 'all callers busy' };
    const target = String(number).replace(/\D/g, '').replace(/^1(\d{10})$/, '$1'); // dial the 10-digit DID
    if ((ctx.busy || new Set()).has(target)) return { kind: 'skip', stream: 'callsToInbox', reason: 'inbox already has a demo call in progress' };
    return callPlan(ctx, 'callsToInbox', rng.pick(callers), target, `Support Inbox (via ${target})`, cfg);
}

function callsCrossTalk(ctx) {
    const { lab, rng } = ctx;
    const cfg = lab.streams.callsCrossTalk;
    const busy = ctx.busy || new Set();
    const callers = pickCallers(ctx, cfg);
    if (!callers.length) return { kind: 'skip', stream: 'callsCrossTalk', reason: 'all callers busy' };
    const caller = rng.pick(callers);
    const toDemo = rng.chance(cfg.toDemoChance ?? 0) && !busy.has(lab.demoUser.ext);
    if (toDemo) return callPlan(ctx, 'callsCrossTalk', caller, lab.demoUser.ext, lab.demoUser.ext, cfg);
    const callees = cfg.callees.filter(ext => ext !== caller && !busy.has(ext));
    if (!callees.length) return { kind: 'skip', stream: 'callsCrossTalk', reason: 'no free callee' };
    const callee = rng.pick(callees);
    assertManaged(lab, lab.homeDomain, callee, 'call');
    return callPlan(ctx, 'callsCrossTalk', caller, callee, callee, cfg);
}

const PLANNERS = { chatToDemo, chatCrossTalk, groupChat, sms, inbox, callsToDemo, callsToInbox, callsCrossTalk };

/**
 * @param {string} name  stream name
 * @param {{lab, rng, sessions, timeScale?, busy?: Set<string>}} ctx
 */
function planStream(name, ctx) {
    const planner = PLANNERS[name];
    if (!planner) throw new Error(`Unknown stream "${name}". Streams: ${ALL_STREAMS.join(', ')}`);
    return planner({ timeScale: 1, ...ctx });
}

module.exports = { chatTransport, planStream, MESSAGE_STREAMS, CALL_STREAMS, ALL_STREAMS, messagePath, toE164Digits };
