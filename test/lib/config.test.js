const fs = require('fs');
const path = require('path');

describe('ConfigLoader', () => {
  let ConfigLoader;
  let originalEnv;
  let originalArgv;

  beforeEach(() => {
    originalEnv = { ...process.env };
    originalArgv = [...process.argv];

    // Clear relevant env vars
    delete process.env.TARGET_SERVER;
    delete process.env.APIKEY;
    delete process.env.MAX_DOMAIN;
    delete process.env.MAX_RESELLERS;
    delete process.env.PEAK_CPS;
    delete process.env.REGISTRATION_PCT;
    delete process.env.SEED;

    // Fresh import each time to avoid state leakage
    jest.resetModules();
    ({ ConfigLoader } = require('../../lib/config'));
  });

  afterEach(() => {
    process.env = originalEnv;
    process.argv = originalArgv;
    jest.restoreAllMocks();
  });

  describe('single server mode', () => {
    beforeEach(() => {
      jest.spyOn(fs, 'existsSync').mockImplementation((p) => {
        if (p.endsWith('servers.json')) return false;
        return false;
      });
    });

    test('loads from env when no servers.json', () => {
      process.env.TARGET_SERVER = 'test.example.com';
      process.env.APIKEY = 'testkey123';

      const loader = new ConfigLoader();
      const config = loader.load();

      expect(config.mode).toBe('single');
      expect(config.servers).toHaveLength(1);
      expect(config.selectedServer.hostname).toBe('test.example.com');
      expect(config.selectedServer.apikey).toBe('testkey123');
      expect(config.selectedServer.id).toBe('default');
    });

    test('throws when TARGET_SERVER missing', () => {
      process.env.APIKEY = 'testkey123';

      const loader = new ConfigLoader();
      expect(() => loader.load()).toThrow('TARGET_SERVER');
    });

    test('throws when APIKEY missing', () => {
      process.env.TARGET_SERVER = 'test.example.com';

      const loader = new ConfigLoader();
      expect(() => loader.load()).toThrow('APIKEY');
    });

    test('applies defaults for optional fields', () => {
      process.env.TARGET_SERVER = 'test.example.com';
      process.env.APIKEY = 'testkey123';

      const loader = new ConfigLoader();
      const config = loader.load();

      expect(config.selectedServer.maxDomains).toBe(10);
      expect(config.selectedServer.peakCps).toBe(10);
      expect(config.selectedServer.registrationPct).toBe(0.8);
    });
  });

  describe('multi server mode', () => {
    const serversJson = {
      servers: [
        { id: 'prod1', hostname: 'prod1.example.com', apikey: 'key1', maxDomains: 20 },
        { id: 'prod2', hostname: 'prod2.example.com', apikey: 'key2', maxDomains: 30 }
      ]
    };

    beforeEach(() => {
      jest.spyOn(fs, 'existsSync').mockImplementation((p) => {
        if (p.endsWith('servers.json')) return true;
        return false;
      });
      jest.spyOn(fs, 'readFileSync').mockImplementation((p) => {
        if (p.endsWith('servers.json')) return JSON.stringify(serversJson);
        return '';
      });
    });

    test('reads and parses servers.json correctly', () => {
      process.argv = ['node', 'server.js', '--server', 'prod1'];

      const loader = new ConfigLoader();
      const config = loader.load();

      expect(config.mode).toBe('multi');
      expect(config.servers).toHaveLength(2);
      expect(config.selectedServer.id).toBe('prod1');
      expect(config.selectedServer.hostname).toBe('prod1.example.com');
    });

    test('throws without --server flag', () => {
      process.argv = ['node', 'server.js'];

      const loader = new ConfigLoader();
      expect(() => loader.load()).toThrow('--server');
    });

    test('throws for unknown server ID', () => {
      process.argv = ['node', 'server.js', '--server', 'unknown'];

      const loader = new ConfigLoader();
      expect(() => loader.load()).toThrow("Server 'unknown' not found");
    });

    test('throws on invalid JSON', () => {
      jest.spyOn(fs, 'readFileSync').mockReturnValue('not json');

      process.argv = ['node', 'server.js', '--server', 'prod1'];
      const loader = new ConfigLoader();
      expect(() => loader.load()).toThrow('Failed to load servers.json');
    });

    test('throws when servers array is missing', () => {
      jest.spyOn(fs, 'readFileSync').mockReturnValue(JSON.stringify({ notServers: [] }));

      process.argv = ['node', 'server.js', '--server', 'prod1'];
      const loader = new ConfigLoader();
      expect(() => loader.load()).toThrow('servers');
    });
  });

  describe('apikeyEnv', () => {
    const serversJson = {
      servers: [
        { id: 'a', hostname: 'a.example.com', apikey: 'inline-key' },
        { id: 'envsrv', hostname: 'env.example.com', apikeyEnv: 'TEST_ENVSRV_KEY' }
      ]
    };

    beforeEach(() => {
      delete process.env.TEST_ENVSRV_KEY;
      jest.spyOn(fs, 'existsSync').mockImplementation(p => p.endsWith('servers.json'));
      jest.spyOn(fs, 'readFileSync').mockImplementation(p => (p.endsWith('servers.json') ? JSON.stringify(serversJson) : ''));
      jest.spyOn(console, 'log').mockImplementation(() => {});
    });

    test('resolves the key from the environment at load time', () => {
      process.env.TEST_ENVSRV_KEY = 'from-env-key';
      process.argv = ['node', 'run.js', '--server', 'envsrv'];
      const { selectedServer } = new ConfigLoader().load();
      expect(selectedServer.apikey).toBe('from-env-key');
    });

    test('an unset variable is a clear error naming the variable, never the key', () => {
      process.argv = ['node', 'run.js', '--server', 'envsrv'];
      expect(() => new ConfigLoader().load()).toThrow(/apikeyEnv "TEST_ENVSRV_KEY".*unset or empty/);
    });

    test('an empty variable is the same error', () => {
      process.env.TEST_ENVSRV_KEY = '';
      process.argv = ['node', 'run.js', '--server', 'envsrv'];
      expect(() => new ConfigLoader().load()).toThrow(/TEST_ENVSRV_KEY/);
    });

    test('an unset variable on a server that is not selected does not block the run', () => {
      process.argv = ['node', 'run.js', '--server', 'a'];
      const { selectedServer } = new ConfigLoader().load();
      expect(selectedServer.apikey).toBe('inline-key');
    });

    test('an inline apikey wins over apikeyEnv', () => {
      serversJson.servers.push({ id: 'both', hostname: 'both.example.com', apikey: 'inline', apikeyEnv: 'TEST_ENVSRV_KEY' });
      process.env.TEST_ENVSRV_KEY = 'env';
      process.argv = ['node', 'run.js', '--server', 'both'];
      expect(new ConfigLoader().load().selectedServer.apikey).toBe('inline');
      serversJson.servers.pop();
    });

    test('the key is never printed', () => {
      process.env.TEST_ENVSRV_KEY = 'super-secret-value';
      process.argv = ['node', 'run.js', '--server', 'envsrv'];
      new ConfigLoader().load();
      expect(JSON.stringify(console.log.mock.calls)).not.toContain('super-secret-value');
    });
  });

  describe('validation', () => {
    beforeEach(() => {
      jest.spyOn(fs, 'existsSync').mockImplementation((p) => {
        if (p.endsWith('servers.json')) return false;
        return false;
      });
    });

    test('throws for invalid hostname format', () => {
      process.env.TARGET_SERVER = 'invalid hostname!';
      process.env.APIKEY = 'testkey';

      const loader = new ConfigLoader();
      expect(() => loader.load()).toThrow('Invalid hostname');
    });

    test('throws for maxDomains < 1', () => {
      process.env.TARGET_SERVER = 'test.example.com';
      process.env.APIKEY = 'testkey';
      process.env.MAX_DOMAIN = '-1';

      const loader = new ConfigLoader();
      expect(() => loader.load()).toThrow('maxDomains');
    });

    test('throws for peakCps <= 0', () => {
      process.env.TARGET_SERVER = 'test.example.com';
      process.env.APIKEY = 'testkey';
      process.env.PEAK_CPS = '-1';

      const loader = new ConfigLoader();
      expect(() => loader.load()).toThrow('peakCps');
    });

    test('throws for registrationPct out of range', () => {
      process.env.TARGET_SERVER = 'test.example.com';
      process.env.APIKEY = 'testkey';
      process.env.REGISTRATION_PCT = '1.5';

      const loader = new ConfigLoader();
      expect(() => loader.load()).toThrow('registrationPct');
    });
  });
});
