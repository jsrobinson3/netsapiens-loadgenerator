// Shared fixtures for the demo-traffic tests. Not a test file (no .test.js).
const { makeRng } = require('../../lib/agent-sim/rng');
const { loadLab } = require('../../demo-traffic/lib/lab');
const { SessionStore } = require('../../demo-traffic/lib/sessions');

const APIKEY = 'test-api-key-not-real';

// The committed lab.json sends v46 chat through Matrix. Most tests exercise the
// messagesessions path, so the helper pins that unless a test asks otherwise
// (`freshLab({ chatTransport: 'matrix' })`, or `{ chatTransport: undefined }` to keep lab.json's own).
function freshLab(overrides = {}) {
  const lab = JSON.parse(JSON.stringify(loadLab()));
  lab.chatTransport = 'messagesessions';
  return Object.assign(lab, overrides);
}

function memStore() {
  return new SessionStore(null, { persist: false });
}

function collectEvents() {
  const lines = [];
  return { lines, log: e => { lines.push(e); return e; } };
}

module.exports = { APIKEY, freshLab, memStore, collectEvents, makeRng };
