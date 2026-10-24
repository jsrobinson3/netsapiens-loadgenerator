// Shared fixtures for the demo-traffic tests. Not a test file (no .test.js).
const { makeRng } = require('../../lib/agent-sim/rng');
const { loadLab } = require('../../demo-traffic/lib/lab');
const { SessionStore } = require('../../demo-traffic/lib/sessions');

const APIKEY = 'test-api-key-not-real';

function freshLab() {
  return JSON.parse(JSON.stringify(loadLab()));
}

function memStore() {
  return new SessionStore(null, { persist: false });
}

function collectEvents() {
  const lines = [];
  return { lines, log: e => { lines.push(e); return e; } };
}

module.exports = { APIKEY, freshLab, memStore, collectEvents, makeRng };
