# demo-traffic

Realistic, low-rate traffic for the v46 phone platform demo (`onecloud-sbz.ucaas.tech`)
so the demo user (ext 4010 "Sumner Robo", DID 9803510486, a human on a HubSpot
softphone) always sees live activity: calls, 1:1 chat, group chat, SMS and shared-inbox
messages. Everything is configured in `lab.json` (committed, no secrets).

## What it simulates

| Stream | What happens | Default |
|---|---|---|
| `chatToDemo` | 4011-4014 send 1:1 chat (multi-turn threads, sometimes bursts) to 4010 | on, 3/hr |
| `chatCrossTalk` | 4011-4014 chat among themselves (4010 sees nothing) | on |
| `groupChat` | 4011-4014 post to the groups in `lab.json` (4010 is not a member and is never the sender) | on |
| `callsToDemo` | partner devices 5101-5104 (onecloud-sbz) dial the demo DID 9803510486 | on, 2/hr |
| `callsToInbox` | partner devices dial the Support Inbox DID 9803510485 (voice to user 2000) | on, 1/hr |
| `callsCrossTalk` | 4011-4014 call each other (and 4010 25% of the time) | on |
| `sms` | partner users text 9803510486 | **off** |
| `inbox` | partner users text the Support Inbox number 9803510485 | **off** |

Timing: jittered exponential inter-arrivals, Mon-Fri 08:00-18:00 America/New_York only
(`--ignore-hours` to override). At most 2 calls at once. Message bursts (2-3 messages
5-40 s apart) happen with some probability. Message text comes from `messages.js`
(100+ turns, seeded selection) and is time-aware: threads can carry `when` tags (morning, midday,
afternoon, eod, weekday, friday, weekend; period and day tags are ANDed) evaluated in
`lab.timeZone` against the (simulated) clock, so no "Coffee run" at 4 PM or on a Saturday.
Untagged threads are always eligible.

Chat cannot cross domains: partner devices only call and text; 4011-4014 chat.

Conversation threads: the platform opens a new conversation for every messagesession id,
so before sending, the daemon GETs `domains/{d}/users/{sender}/messagesessions` and reuses
the session whose `messagesession-remote` matches the destination (numbers are normalised:
non-digits stripped, leading `1` dropped from 11-digit NANP numbers, so `9803510486` ==
`19803510486`). A sid is minted only if none exists and is cached in
`state/demo-traffic/sessions.json` keyed by sender + normalised remote. One lookup per
conversation per run. `--dry-run` skips the lookup and uses the cached or minted sid.

## Chat transport (`chatTransport` in lab.json)

On v46 the phone and Horizon read chat from Matrix, not from the NS `messagesessions`
API, so chat posted there is invisible. `"chatTransport": "matrix"` (committed) sends
`chatToDemo`, `chatCrossTalk` and `groupChat` through Matrix (`lib/matrix.js`);
`"messagesessions"` (the default when the key is absent, and the only choice on a v45
core) keeps the old behaviour and the section above. SMS and inbox always use
messagesessions.

Per message, as the sender (ext only, never 4010 or any protected/onecloud-sbz user):

1. delegated NS JWT: `POST /ns-api/v2/jwt` (server apikey), then
   `POST /ns-api/v2/matrix/token` with device id `DEMOTRAFFIC<ext>`. Cached in memory per
   sender, re-minted only on a Matrix 401 (retried once). A 404 means a v45 core and fails
   with a clear error.
2. peer Matrix ids come from the sender's contacts (`matrix-user-id`, lowercased, cached 60 s),
   never built from the extension.
3. 1:1: reuse the last room for the peer in the sender's `m.direct`, else `createRoom`
   (`trusted_private_chat`, `is_direct`) and append it to `m.direct` (other entries kept).
4. group: a named private room (`lab.groupNames`) created once by the first sender with the
   rest invited, id saved per group in `state/demo-traffic/matrix-rooms.json` and reused.
5. demo colleagues (4011-4014) run no client, so when one is invited the generator JOINs as
   that colleague with their own token (and, for 1:1, adds the room to their `m.direct` so
   replies reuse it). The demo user 4010 is only ever invited, never acted as.
6. `PUT /rooms/{room}/send/m.room.message/{txn}` with a unique txn id; a burst reuses the room.

`--dry-run` stays offline: it prints the planned Matrix steps (no tokens, no network, no
files written). Tokens are never logged.

## Setup

```bash
# 1. SIPp image (calls and the always-on answerers run in Docker)
docker build -t loadgen-sipp:3.7.7 docker/sipp

# 2. Create users 4011-4014 (home domain) and 5101-5104 (partner domain) + one device each
node demo-traffic/build.js --server v46 --dry-run     # review first (offline, secrets redacted)
node demo-traffic/build.js --server v46               # idempotent upsert (POST, PUT on 409)
```

`build.js` only touches extensions listed in `lab.json` `create.users` and throws on any
other (including the protected ones below). Device name is the extension; the SIP
password is `HMAC(apikey, "demo-traffic:<domain>:<ext>")`, so it is reproducible and never
stored in git. Device rows are written to the gitignored `state/demo-traffic/devices.csv`
(mode 0600).

3. **Add 4011-4014 to the Support Inbox in the UI.** Shared-inbox membership is
   owner-managed and not set by the API from here.

## Running

```bash
# Offline: show what would happen (no API writes, no SIP calls, no files written)
node demo-traffic/run.js --server v46 --dry-run --ignore-hours --once callsToDemo
node demo-traffic/run.js --server v46 --dry-run --ignore-hours --once groupChat
node demo-traffic/run.js --server v46 --dry-run            # prints the answerers command + schedule

# Smoke tests: fire exactly one event of a stream (LIVE unless --dry-run)
node demo-traffic/run.js --server v46 --once chatToDemo --ignore-hours
node demo-traffic/run.js --server v46 --once callsToDemo --ignore-hours

# Daemon (Ctrl-C / SIGTERM stops answerers and lets in-flight calls finish; second signal force-kills)
node demo-traffic/run.js --server v46
nohup node demo-traffic/run.js --server v46 >> state/demo-traffic/daemon.log 2>&1 &
```

Options: `--server <name>`, `--dry-run`, `--once <stream>`, `--time-scale N` (compress
inter-arrival gaps and burst delays N-fold for testing), `--ignore-hours`.

A cron `@reboot` entry or a systemd user service running the daemon command works; the
daemon is self-contained and logs one line per event to stdout and a redacted JSONL copy to
`state/demo-traffic/events.jsonl` (not written in dry run).

Answerers: one SIPp container (`demo-traffic-answerers`) keeps 4011-4014 and the partner
devices registered and auto-answering (never 4010). It is restarted if it exits (the
registration scenario ends about every 58 minutes). Call streams use templated copies of
`sipp/scripts/sipp_uac_agent_dial.xml` under `state/demo-traffic/work/`; existing scenarios
are never modified and temp files are removed after each call.

## SMS and shared-inbox caveat

`sms` and `inbox` are `enabled: false` in `lab.json`. SMS needs (a) a `fromNumber` on the
senders and (b) confirmation that SMS delivery between platform numbers actually works;
the inbox also needs 4011-4014 added as inbox members in the UI. The Support Inbox
(user 2000) has DID and SMS number 9803510485 (`streams.inbox.inboxNumber`). Until
enabled, `--once sms` / `--once inbox` log a skip and send nothing. API sends return 202 and
the outbound status stays "sending"; that is normal, not an error.

## Safety rules

- Never act as ext 4010 (the human demo user): no logins, registrations, sends, or calls
  as 4010. `allowDemoUserReplies` is `false`; the group sender is never 4010.
- Never touch `onecloud-sbz` users 1000-1012, or `sumnersawesomephones` 1001, 1002, 2000,
  6300, 8001 (`lab.json` `protected`; `build.js` and the stream planners refuse them).
  Calls to the inbox go to its DID, never as or from user 2000.
- No API keys or SIP passwords in git, logs, events, or dry-run output (redacted `***`).
- Messages and calls are low volume by design; do not raise `ratePerHour` against a
  shared platform without agreement.

## Tests

```bash
npx jest test/demo-traffic       # offline, no network
```
