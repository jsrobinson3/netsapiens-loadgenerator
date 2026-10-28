const fs = require('fs');
const os = require('os');
const path = require('path');
const lab = require('../../demo-traffic/lib/lab');
const sipp = require('../../demo-traffic/lib/sipp');
const { containerName, CONTAINER, prepareAnswerers } = require('../../demo-traffic/lib/answerers');
const { prepareCall } = require('../../demo-traffic/lib/calls');
const { parseArgs } = require('../../demo-traffic/run');
const { parseArgs: parseBuildArgs } = require('../../demo-traffic/build');
const { APIKEY, freshLab } = require('./helpers');

const { REPO, STATE_DIR, LAB_PATH } = lab;
const EXAMPLE = path.join(REPO, 'demo-traffic', 'lab.v46lab.example.json');

describe('lab id and state namespacing', () => {
  let tmp;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'demo-traffic-lab-')); });
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

  const writeLab = (name, patch = {}) => {
    const file = path.join(tmp, name);
    fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(fs.readFileSync(LAB_PATH, 'utf8')), ...patch }));
    return file;
  };

  test('the default lab.json without an id keeps the original un-namespaced state dir', () => {
    const l = lab.loadLab();
    expect(l.id).toBeUndefined();
    expect(lab.labStateDir(l)).toBe(STATE_DIR);
    expect(lab.labStateDir(lab.loadLab('demo-traffic/lab.json'))).toBe(STATE_DIR);
    expect(lab.labStateDir(lab.loadLab(LAB_PATH))).toBe(STATE_DIR);
    expect(sipp.workDir(l)).toBe(sipp.WORK_DIR);
    expect(containerName(l)).toBe(CONTAINER);
  });

  test('another lab file is namespaced by its id', () => {
    const file = writeLab('whatever.json', { id: 'alpha' });
    const l = lab.loadLab(file);
    expect(l.id).toBe('alpha');
    expect(lab.labStateDir(l)).toBe(path.join(STATE_DIR, 'alpha'));
    expect(sipp.workDir(l)).toBe(path.join(STATE_DIR, 'alpha', 'work'));
    expect(containerName(l)).toBe(`${CONTAINER}-alpha`);
  });

  test('a non-default lab file with no id uses its basename without .json', () => {
    const l = lab.loadLab(writeLab('second-env.json'));
    expect(l.id).toBe('second-env');
    expect(lab.labStateDir(l)).toBe(path.join(STATE_DIR, 'second-env'));
  });

  test('an explicit id on the default lab.json is honoured (namespaced)', () => {
    const l = JSON.parse(fs.readFileSync(LAB_PATH, 'utf8'));
    l.id = 'v46';
    expect(lab.labStateDir(l)).toBe(path.join(STATE_DIR, 'v46'));
  });

  test('relative lab paths resolve from the repo root, not the cwd', () => {
    expect(lab.resolveLabPath('demo-traffic/lab.json')).toBe(LAB_PATH);
    expect(lab.resolveLabPath()).toBe(LAB_PATH);
    expect(lab.resolveLabPath('/abs/x.json')).toBe('/abs/x.json');
    const l = lab.loadLab('demo-traffic/lab.v46lab.example.json');
    expect(l.id).toBe('v46lab');
  });

  test('a missing lab file gives a clear error', () => {
    expect(() => lab.loadLab(path.join(tmp, 'nope.json'))).toThrow(/Cannot read lab file .*nope\.json/);
  });

  test('ids that could escape the state dir are rejected', () => {
    for (const id of ['../x', 'a/b', '', '.hidden', 'a b']) {
      expect(() => lab.validateLab({ ...freshLab(), id })).toThrow(/id must be/);
    }
  });

  test('sipp.portOffset must be an integer 0-300', () => {
    for (const portOffset of [-1, 301, 1.5, '300']) {
      const l = freshLab();
      l.sipp.portOffset = portOffset;
      expect(() => lab.validateLab(l)).toThrow(/portOffset/);
    }
    const ok = freshLab();
    ok.sipp.portOffset = 300;
    expect(() => lab.validateLab(ok)).not.toThrow();
  });
});

describe('two daemons side by side', () => {
  const other = () => {
    const l = freshLab();
    l.id = 'v46lab';
    l.sipp.portOffset = 300;
    return l;
  };
  const NET = { sut: '203.0.113.9', localIp: '10.0.0.5', mediaIp: '198.51.100.7' };

  test('SIPp ports and answerer ports are disjoint between a default and an offset lab', () => {
    const a = freshLab();
    const b = other();
    const used = l => [
      ...Object.values(sipp.answererPorts(l)),
      ...[0, 1].flatMap(s => Object.values(sipp.slotPorts(s, l)))
    ];
    expect(used(a)).toEqual([
      5090, 5091, 61000, 5100, 5200, 62000, 5101, 5201, 62010
    ]);
    const clash = used(a).filter(p => used(b).includes(p));
    expect(clash).toEqual([]);
    // sip/control ports must not overlap each other across labs either (media ranges are 10 wide per slot)
    expect(Math.max(...used(b))).toBeLessThan(65536);
  });

  test('the default lab keeps today\'s exact ports and container', () => {
    expect(sipp.slotPorts(0)).toEqual({ sip: 5100, control: 5200, media: 62000 });
    expect(sipp.answererPorts(freshLab())).toEqual(sipp.ANSWERER_PORTS);
  });

  test('answerers get their own container, ports and work files per lab', () => {
    const b = other();
    const p = prepareAnswerers(b, { apikey: APIKEY, ...NET, uasTemplate: null });
    const cmd = sipp.formatCommand(p.argv);
    expect(cmd).toContain('--name demo-traffic-answerers-v46lab');
    expect(cmd).toContain('-p 5390 -cp 5391');
    expect(cmd).toContain('-mp 64000');
    expect(p.uasPath).toBe(path.join(STATE_DIR, 'v46lab', 'work', 'answerers-uas.xml'));
    const a = prepareAnswerers(freshLab(), { apikey: APIKEY, ...NET, uasTemplate: null });
    expect(sipp.formatCommand(a.argv)).toContain('--name demo-traffic-answerers ');
    expect(a.uasPath).toBe(path.join(STATE_DIR, 'work', 'answerers-uas.xml'));
  });

  test('calls use the lab\'s work dir and shifted ports', () => {
    const b = other();
    const plan = { caller: b.create.users.find(u => u.ext === '5101'), target: b.demoUser.did, audio: 'g711a-orig', talkMs: 30000 };
    const p = prepareCall(plan, { lab: b, apikey: APIKEY, ...NET, slot: 0, id: '1-1', dialTemplate: '<x>__AUDIO__ __TALK_MS__ [media_ip]</x>' });
    expect(p.scenarioPath).toBe(path.join(STATE_DIR, 'v46lab', 'work', 'call-1-1.xml'));
    expect(sipp.formatCommand(p.argv)).toContain('-p 5400 -cp 5500 -mp 65000');
  });
});

describe('--lab argument', () => {
  test('run.js: optional, defaults to undefined (lab.json), takes a path', () => {
    expect(parseArgs(['--server', 'v46']).lab).toBeUndefined();
    expect(parseArgs(['--server', 'v46lab', '--lab', 'demo-traffic/lab.v46lab.example.json']).lab).toBe('demo-traffic/lab.v46lab.example.json');
    expect(() => parseArgs(['--lab'])).toThrow(/--lab needs a path/);
  });

  test('build.js parses --lab too', () => {
    expect(parseBuildArgs(['--lab', 'x.json', '--dry-run']).lab).toBe('x.json');
    expect(parseBuildArgs(['--dry-run']).lab).toBeUndefined();
    expect(() => parseBuildArgs(['--lab'])).toThrow(/--lab needs a path/);
  });
});

describe('lab.v46lab.example.json template', () => {
  const example = JSON.parse(fs.readFileSync(EXAMPLE, 'utf8'));

  test('loads and validates, with every stream disabled', () => {
    const l = lab.loadLab(EXAMPLE);
    expect(l.id).toBe('v46lab');
    expect(l.server).toBe('v46lab');
    expect(l.demoUser).toMatchObject({ domain: 'onecloud.com', ext: '1001' });
    expect(l.homeDomain).toBe('onecloud.com');
    expect(Object.keys(l.streams).length).toBeGreaterThan(0);
    for (const [name, s] of Object.entries(l.streams)) expect([name, s.enabled]).toEqual([name, false]);
    expect(example.description).toMatch(/TEMPLATE/);
  });

  test('is flagged as unfinished until the TODO placeholders are replaced', () => {
    const todo = lab.findPlaceholders(example);
    expect(todo).toEqual(expect.arrayContaining(['demoUser.did', 'partnerDomain', 'streams.inbox.inboxNumber']));
    expect(lab.findPlaceholders(lab.loadLab())).toEqual([]);
  });

  test('findPlaceholders walks nested values', () => {
    expect(lab.findPlaceholders({ a: 'TODO-x', b: ['ok', 'TODO'], c: { d: 'not TODO' } })).toEqual(['a', 'b[1]']);
  });
});
