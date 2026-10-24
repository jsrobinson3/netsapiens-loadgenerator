const { planUser, planBuild, describeRequest, runBuild, parseArgs } = require('../../demo-traffic/build');
const { devicePassword, deviceCsv, redact, validateLab } = require('../../demo-traffic/lib/lab');
const { APIKEY, freshLab } = require('./helpers');

describe('planBuild', () => {
  test('one user and one device request per create.users entry', () => {
    const lab = freshLab();
    const plan = planBuild(lab, APIKEY);
    expect(plan).toHaveLength(lab.create.users.length * 2);
    expect(plan.filter(r => r.label.startsWith('device ')).length).toBe(lab.create.users.length);
  });

  test('device name is the extension and the password is the HMAC', () => {
    const lab = freshLab();
    const [, dev] = planUser(lab, lab.create.users[0], APIKEY);
    const u = lab.create.users[0];
    expect(dev.createBody.device).toBe(u.ext);
    expect(dev.createBody['device-sip-registration-password']).toBe(devicePassword(APIKEY, u.domain, u.ext));
    expect(devicePassword(APIKEY, u.domain, u.ext)).toHaveLength(20);
    expect(devicePassword('other-key', u.domain, u.ext)).not.toBe(devicePassword(APIKEY, u.domain, u.ext));
  });

  test('sets the caller-id fields', () => {
    const lab = freshLab();
    const partner = lab.create.users.find(u => u.ext === '5101');
    const [user] = planUser(lab, partner, APIKEY);
    expect(user.createBody['caller-id-name']).toBe('Brightline Dent');
    expect(user.createBody['caller-id-number']).toBe('16195550141');
    expect(user.updatePath).toBe('domains/onecloud-sbz/users/5101');
  });

  test('refuses an extension that is not in create.users', () => {
    const lab = freshLab();
    expect(() => planBuild(lab, APIKEY, ['4011', '9999'])).toThrow(/not listed in lab.json create.users/);
    expect(() => planBuild(lab, APIKEY, ['4010'])).toThrow(/not listed/);
    expect(() => planBuild(lab, APIKEY, ['1001'])).toThrow(/not listed/);
  });

  test('planUser refuses protected and unlisted users directly', () => {
    const lab = freshLab();
    const base = { first: 'A', last: 'B', department: 'X', scope: 'Basic User' };
    expect(() => planUser(lab, { ...base, domain: 'sumnersawesomephones', ext: '4010' }, APIKEY)).toThrow(/protected/);
    expect(() => planUser(lab, { ...base, domain: 'onecloud-sbz', ext: '1005' }, APIKEY)).toThrow(/protected/);
    expect(() => planUser(lab, { ...base, domain: 'sumnersawesomephones', ext: '4999' }, APIKEY)).toThrow(/not listed/);
  });

  test('lab validation rejects protected users in create.users', () => {
    const lab = freshLab();
    lab.create.users.push({ domain: 'onecloud-sbz', ext: '1000', first: 'N', last: 'O', department: 'X' });
    expect(() => validateLab(lab)).toThrow(/protected user onecloud-sbz\/1000/);
  });

  test('--only is parsed', () => {
    expect(parseArgs(['--server', 'v46', '--dry-run', '--only', '4011, 5101'])).toEqual({ dryRun: true, only: ['4011', '5101'] });
    expect(parseArgs(['--server', 'v46'])).toEqual({ dryRun: false, only: null });
  });
});

describe('dry run output', () => {
  test('redacts the device password and never calls the client', async () => {
    const lab = freshLab();
    const out = [];
    const client = { apiPostJson: jest.fn(), apiPutJson: jest.fn() };
    const r = await runBuild({ lab, client, apikey: APIKEY, dryRun: true, out: l => out.push(l) });
    const text = out.join('\n');
    expect(client.apiPostJson).not.toHaveBeenCalled();
    expect(client.apiPutJson).not.toHaveBeenCalled();
    expect(r.planned).toBe(lab.create.users.length * 2);
    expect(text).toContain('"device-sip-registration-password":"***"');
    for (const u of lab.create.users) expect(text).not.toContain(devicePassword(APIKEY, u.domain, u.ext));
    expect(text).not.toContain(APIKEY);
  });

  test('describeRequest redacts', () => {
    const lab = freshLab();
    const [, dev] = planUser(lab, lab.create.users[0], APIKEY);
    expect(describeRequest(dev)).toContain('***');
    expect(describeRequest(dev)).not.toContain(dev.createBody['device-sip-registration-password']);
  });
});

describe('runBuild (live path, fake client)', () => {
  test('POSTs, and on 409 PUTs the update', async () => {
    const lab = freshLab();
    const posts = [];
    const puts = [];
    const client = {
      apiPostJson: jest.fn(async (p, body) => {
        posts.push(p);
        if (p.endsWith('/devices')) { const e = new Error('exists'); e.response = { status: 409 }; throw e; }
        return { status: 201 };
      }),
      apiPutJson: jest.fn(async p => { puts.push(p); return { status: 200 }; })
    };
    const r = await runBuild({ lab, client, apikey: APIKEY, dryRun: false, only: ['4011'], out: () => {} });
    expect(posts).toEqual(['domains/sumnersawesomephones/users', 'domains/sumnersawesomephones/users/4011/devices']);
    expect(puts).toEqual(['domains/sumnersawesomephones/users/4011/devices/4011']);
    expect(r).toMatchObject({ created: 1, updated: 1, failed: 0 });
  });

  test('a non-409 failure is counted and does not abort the rest', async () => {
    const lab = freshLab();
    const client = {
      apiPostJson: jest.fn(async () => { const e = new Error('boom'); e.response = { status: 500 }; throw e; }),
      apiPutJson: jest.fn()
    };
    const out = [];
    const r = await runBuild({ lab, client, apikey: APIKEY, dryRun: false, only: ['4011', '4012'], out: l => out.push(l) });
    expect(r.failed).toBe(4);
    expect(client.apiPutJson).not.toHaveBeenCalled();
    expect(out.join('\n')).not.toContain(devicePassword(APIKEY, 'sumnersawesomephones', '4011'));
  });

  test('a refused extension throws before any request is sent', async () => {
    const client = { apiPostJson: jest.fn(), apiPutJson: jest.fn() };
    await expect(runBuild({ lab: freshLab(), client, apikey: APIKEY, dryRun: false, only: ['4010'], out: () => {} }))
      .rejects.toThrow(/not listed/);
    expect(client.apiPostJson).not.toHaveBeenCalled();
  });
});

describe('device csv', () => {
  test('covers both domains and is SEQUENTIAL with CRLF', () => {
    const lab = freshLab();
    const csv = deviceCsv(lab.create.users, APIKEY);
    const lines = csv.split('\r\n').filter(Boolean);
    expect(lines[0]).toBe('SEQUENTIAL');
    expect(lines).toHaveLength(lab.create.users.length + 1);
    expect(csv).toContain(';sumnersawesomephones;');
    expect(csv).toContain(';onecloud-sbz;');
    expect(csv).not.toContain(';4010;');
    expect(redact(csv)).not.toContain(devicePassword(APIKEY, 'onecloud-sbz', '5101'));
  });
});
