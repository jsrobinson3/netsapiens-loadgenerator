const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const sipp = require('../../demo-traffic/lib/sipp');
const { CallRunner, prepareCall } = require('../../demo-traffic/lib/calls');
const { Answerers, prepareAnswerers, CONTAINER } = require('../../demo-traffic/lib/answerers');
const { EventLog } = require('../../demo-traffic/lib/events');
const { devicePassword, REPO } = require('../../demo-traffic/lib/lab');
const { APIKEY, freshLab, collectEvents, makeRng } = require('./helpers');
const { planStream } = require('../../demo-traffic/lib/streams');
const { memStore } = require('./helpers');

const NET = { sut: '203.0.113.9', localIp: '10.0.0.5', mediaIp: '198.51.100.7' };
const netFn = async () => NET;

function callPlan(lab, ext = '5101') {
  const user = lab.create.users.find(u => u.ext === ext);
  return {
    kind: 'call', stream: 'callsToDemo', caller: user, target: lab.demoUser.did,
    targetLabel: '4010 (via 9803510486)', audio: 'g711a-short-orig1', talkMs: 45123
  };
}

function fakeChild() {
  const c = new EventEmitter();
  c.kill = jest.fn();
  return c;
}

describe('scenario template', () => {
  const lab = freshLab();
  const template = sipp.readTemplate(lab, 'dialScenario');

  test('fills __AUDIO__, __TALK_MS__ and [media_ip]', () => {
    const xml = sipp.renderDialScenario(template, { audio: 'g711a-orig', talkMs: 61234.6, mediaIp: '198.51.100.7' });
    expect(xml).not.toContain('__AUDIO__');
    expect(xml).not.toContain('__TALK_MS__');
    expect(xml).not.toContain('[media_ip]');
    expect(xml).toContain('g711a-orig.pcap');
    expect(xml).toContain('61235');
    expect(xml).toContain('198.51.100.7');
  });

  test('does not modify the template file on disk', () => {
    sipp.renderDialScenario(template, { audio: 'g711a-orig', talkMs: 1000, mediaIp: '1.2.3.4' });
    expect(fs.readFileSync(path.join(sipp.SCRIPTS_DIR, lab.sipp.dialScenario), 'utf8')).toBe(template);
  });

  test('rejects an unsafe audio name and a template without placeholders', () => {
    expect(() => sipp.renderDialScenario(template, { audio: '../etc/passwd', talkMs: 1, mediaIp: '1.1.1.1' })).toThrow(/Unsafe audio/);
    expect(() => sipp.renderDialScenario('<scenario/>', { audio: 'a', talkMs: 1 })).toThrow(/placeholders/);
  });

  test('every configured pcap exists', () => {
    for (const a of lab.streams.callsToDemo.audio) expect(sipp.pcapExists(a)).toBe(true);
    expect(sipp.pcapExists('does-not-exist')).toBe(false);
  });
});

describe('caller csv and command', () => {
  const lab = freshLab();
  const plan = callPlan(lab);

  test('one SEQUENTIAL line for the calling device with its HMAC password', () => {
    const csv = sipp.callerCsv(plan.caller, APIKEY);
    const lines = csv.split('\r\n').filter(Boolean);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toBe('SEQUENTIAL');
    expect(lines[1]).toBe(`Kim Nguyen;5101;onecloud-sbz;[authentication username=5101 password=${devicePassword(APIKEY, 'onecloud-sbz', '5101')}];demo-traffic`);
  });

  test('docker command: repo mount, sipp/scripts cwd, -sf/-inf/-key dial_ext/-m 1', () => {
    const p = prepareCall(plan, { lab, apikey: APIKEY, ...NET, slot: 0, id: 't1', dialTemplate: sipp.readTemplate(lab, 'dialScenario') });
    const cmd = sipp.formatCommand(p.argv);
    expect(p.cwd).toBe(path.join(REPO, 'sipp', 'scripts'));
    expect(p.argv.slice(0, 3)).toEqual(['docker', 'run', '--name']);
    expect(cmd).toContain(`-v ${REPO}:${REPO}`);
    expect(cmd).toContain(`-w ${REPO}/sipp/scripts loadgen-sipp:3.7.7`);
    expect(cmd).toContain(`-sf ${p.scenarioPath}`);
    expect(cmd).toContain(`-inf ${p.csvPath}`);
    expect(cmd).toContain('-key dial_ext 9803510486');
    expect(cmd).toContain('-m 1');
    expect(cmd).toContain('-i 10.0.0.5');
    expect(cmd.startsWith('docker run --name demo-traffic-call-t1 --rm --network host')).toBe(true);
    expect(p.scenarioPath.startsWith(path.join(REPO, 'state', 'demo-traffic', 'work'))).toBe(true);
    expect(p.argv).toContain(NET.sut);
    expect(p.scenarioXml).toContain('198.51.100.7');
    expect(p.scenarioXml).toContain('45123');
    // the SIP password is only in the CSV, never on the command line
    expect(cmd).not.toContain(devicePassword(APIKEY, 'onecloud-sbz', '5101'));
  });

  test('each slot gets its own ports', () => {
    expect(sipp.slotPorts(0)).not.toEqual(sipp.slotPorts(1));
    expect(sipp.slotPorts(0).sip).not.toBe(sipp.ANSWERER_PORTS.sip);
  });

  test('redact hides passwords in any text', () => {
    const { redact } = require('../../demo-traffic/lib/lab');
    expect(redact('x [authentication username=1 password=abc123] y')).toBe('x [authentication username=1 password=***] y');
  });
});

describe('CallRunner dry run', () => {
  test('prints the full command with the password redacted, writes and spawns nothing', async () => {
    const lab = freshLab();
    const spawnFn = jest.fn();
    const out = [];
    const spy = jest.spyOn(console, 'log').mockImplementation(l => out.push(String(l)));
    const events = new EventLog({ dryRun: true, out: l => out.push(l) });
    const runner = new CallRunner({ lab, apikey: APIKEY, net: netFn, dryRun: true, events, busy: new Set(), spawnFn });
    const r = await runner.run({ ...callPlan(lab), stream: 'callsToDemo' });
    spy.mockRestore();
    const text = out.join('\n');
    expect(r.dry).toBe(true);
    expect(spawnFn).not.toHaveBeenCalled();
    expect(text).toContain('cwd:     sipp/scripts');
    expect(text).toContain('command: docker run');
    expect(text).toContain('-key dial_ext 9803510486');
    expect(text).toContain('password=***');
    expect(text).not.toContain(devicePassword(APIKEY, 'onecloud-sbz', '5101'));
    expect(fs.existsSync(path.join(sipp.WORK_DIR, `call-${process.pid}-1.xml`))).toBe(false);
  });
});

describe('CallRunner live path (fake spawn)', () => {
  test('writes the scenario and csv, spawns in sipp/scripts, then cleans up', async () => {
    const lab = freshLab();
    const ev = collectEvents();
    const busy = new Set();
    let seen = null;
    const spawnFn = jest.fn((file, args, opts) => {
      const child = fakeChild();
      const sf = args[args.indexOf('-sf') + 1];
      const inf = args[args.indexOf('-inf') + 1];
      seen = { sf, inf, exists: fs.existsSync(sf) && fs.existsSync(inf), mode: fs.statSync(inf).mode & 0o777, busy: [...busy], cwd: opts.cwd };
      setImmediate(() => child.emit('exit', 0));
      return child;
    });
    const runner = new CallRunner({ lab, apikey: APIKEY, net: netFn, dryRun: false, events: ev, busy, spawnFn });
    const r = await runner.run(callPlan(lab));
    expect(r).toMatchObject({ ok: true, exitCode: 0 });
    expect(seen.exists).toBe(true);
    expect(seen.mode).toBe(0o600);
    expect(seen.cwd).toBe(sipp.SCRIPTS_DIR);
    expect(seen.busy.sort()).toEqual(['4010', '5101']);
    expect(fs.existsSync(seen.sf)).toBe(false);
    expect(fs.existsSync(seen.inf)).toBe(false);
    expect(busy.size).toBe(0);
    expect(ev.lines.map(e => e.action)).toEqual(['call-start', 'call-end']);
    expect(JSON.stringify(ev.lines)).not.toContain(devicePassword(APIKEY, 'onecloud-sbz', '5101'));
  });

  test('caps concurrent calls (default 2) and skips the third', async () => {
    const lab = freshLab();
    expect(lab.options.maxConcurrentCalls).toBe(2);
    const ev = collectEvents();
    const children = [];
    const spawnFn = jest.fn(() => { const c = fakeChild(); children.push(c); return c; });
    const runner = new CallRunner({ lab, apikey: APIKEY, net: netFn, dryRun: false, events: ev, busy: new Set(), spawnFn });
    const p1 = runner.run(callPlan(lab, '5101'));
    const p2 = runner.run(callPlan(lab, '5102'));
    await new Promise(r => setImmediate(r));
    await new Promise(r => setImmediate(r));
    expect(runner.active).toBe(2);
    const third = await runner.run(callPlan(lab, '5103'));
    expect(third.skipped).toBe(true);
    expect(spawnFn).toHaveBeenCalledTimes(2);
    expect(ev.lines.some(e => e.action === 'call-skipped')).toBe(true);
    children.forEach(c => c.emit('exit', 0));
    await Promise.all([p1, p2]);
    expect(runner.active).toBe(0);
    expect(runner.freeSlot()).toBe(0);
  });

  test('a spawn error is reported and still cleans up', async () => {
    const lab = freshLab();
    const ev = collectEvents();
    const spawnFn = jest.fn(() => { const c = fakeChild(); setImmediate(() => c.emit('error', new Error('no docker'))); return c; });
    const runner = new CallRunner({ lab, apikey: APIKEY, net: netFn, dryRun: false, events: ev, busy: new Set(), spawnFn });
    const r = await runner.run(callPlan(lab));
    expect(r.ok).toBe(false);
    expect(runner.active).toBe(0);
    expect(fs.readdirSync(sipp.WORK_DIR).filter(f => f.startsWith(`call-${process.pid}-`))).toEqual([]);
  });

  test('a missing pcap fails the call without spawning', async () => {
    const lab = freshLab();
    const spawnFn = jest.fn();
    const ev = collectEvents();
    const runner = new CallRunner({ lab, apikey: APIKEY, net: netFn, dryRun: false, events: ev, busy: new Set(), spawnFn });
    const r = await runner.run({ ...callPlan(lab), audio: 'no-such-pcap' });
    expect(r.ok).toBe(false);
    expect(spawnFn).not.toHaveBeenCalled();
  });
});

describe('answerers', () => {
  test('register 4011-4014 and the partner devices, never 4010 or the 1000 series', () => {
    const lab = freshLab();
    const uas = sipp.readTemplate(lab, 'answererScenario');
    const p = prepareAnswerers(lab, { apikey: APIKEY, ...NET, uasTemplate: uas });
    expect(p.users.map(u => u.ext)).toEqual(['4011', '4012', '4013', '4014', '5101', '5102', '5103', '5104']);
    expect(p.csv).not.toContain(';4010;');
    expect(p.csv).not.toMatch(/;1\d{3};/);
    const cmd = sipp.formatCommand(p.argv);
    expect(cmd).toContain('register.and.subscribe.sipp.xml');
    expect(cmd).toContain('-oocsf ' + p.uasPath);
    expect(cmd).toContain('-key reg_loops 78');
    expect(cmd).toContain('-key expires 60');
    expect(cmd).toContain('-m 8');
    expect(cmd).toContain(`--name ${CONTAINER}`);
    expect(p.cwd).toBe(sipp.SCRIPTS_DIR);
  });

  test('refuses to register a device not in create.users', () => {
    const lab = freshLab();
    lab.answerers.devices.push('4010');
    expect(() => prepareAnswerers(lab, { apikey: APIKEY, ...NET })).toThrow(/not in lab.json create.users/);
    const lab2 = freshLab();
    lab2.answerers.devices.push('1001');
    expect(() => prepareAnswerers(lab2, { apikey: APIKEY, ...NET })).toThrow(/not in lab.json create.users/);
  });

  test('dry run prints one registration command with passwords redacted', async () => {
    const lab = freshLab();
    const out = [];
    const spy = jest.spyOn(console, 'log').mockImplementation(l => out.push(String(l)));
    const spawnFn = jest.fn();
    const events = new EventLog({ dryRun: true, out: l => out.push(l) });
    const a = new Answerers({ lab, apikey: APIKEY, net: netFn, dryRun: true, events, spawnFn, spawnSyncFn: jest.fn() });
    await a.start();
    spy.mockRestore();
    const text = out.join('\n');
    expect(spawnFn).not.toHaveBeenCalled();
    expect(text).toContain('password=***');
    expect(text).not.toContain(devicePassword(APIKEY, 'sumnersawesomephones', '4011'));
  });

  test('restarts when the process exits, and stop() kills the container and stays stopped', async () => {
    jest.useFakeTimers();
    try {
      const lab = freshLab();
      const ev = collectEvents();
      const children = [];
      const spawnFn = jest.fn(() => { const c = fakeChild(); children.push(c); return c; });
      const spawnSyncFn = jest.fn();
      const a = new Answerers({ lab, apikey: APIKEY, net: netFn, dryRun: false, events: ev, spawnFn, spawnSyncFn, backoffMs: [10] });
      await a.start();
      expect(spawnFn).toHaveBeenCalledTimes(1);
      expect(spawnSyncFn).toHaveBeenCalledWith('docker', ['rm', '-f', CONTAINER], expect.anything());
      children[0].emit('exit', 0);
      jest.advanceTimersByTime(2000);
      expect(spawnFn).toHaveBeenCalledTimes(2);
      a.stop();
      expect(spawnSyncFn).toHaveBeenCalledWith('docker', ['kill', CONTAINER], expect.anything());
      children[1].emit('exit', 0);
      jest.advanceTimersByTime(120000);
      expect(spawnFn).toHaveBeenCalledTimes(2);
      expect(ev.lines.map(e => e.action)).toEqual(expect.arrayContaining(['answerers-start', 'answerers-exited', 'answerers-stopped']));
    } finally {
      jest.useRealTimers();
    }
  });
});

describe('call planning feeds the runner', () => {
  test('callsToDemo plans a callable plan from lab.json', () => {
    const lab = freshLab();
    const p = planStream('callsToDemo', { lab, rng: makeRng(1), sessions: memStore() });
    const prepared = prepareCall(p, { lab, apikey: APIKEY, ...NET, slot: 1, id: 'x', dialTemplate: sipp.readTemplate(lab, 'dialScenario') });
    expect(prepared.csv).toContain(`;${p.caller.ext};`);
    expect(prepared.argv).toContain(String(sipp.slotPorts(1).sip));
  });
});
