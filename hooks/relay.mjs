#!/usr/bin/env node
// Claude Code hook relay: forwards the hook JSON (stdin) to the Agent Office.
// Always exits 0 and prints nothing, so it can never block or alter Claude's behavior.
// Uses node:http directly (not fetch) so proxy environment variables never reroute localhost.
import http from 'node:http';

// Chat answers are produced by short claude runs started by the office itself: never show those as agents.
if (process.env.AGENT_OFFICE_SKIP) process.exit(0);

const target = new URL(process.env.AGENT_OFFICE_URL || 'http://127.0.0.1:5199/api/event');
const done = () => process.exit(0);
setTimeout(done, 3000).unref();

let data = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => (data += c));
process.stdin.on('error', done);
process.stdin.on('end', () => {
  // tasks started from the manager desk carry their run id, so the office knows which character is doing them
  if (process.env.AGENT_OFFICE_RUN) {
    try {
      const j = JSON.parse(data || '{}');
      j.office_run = process.env.AGENT_OFFICE_RUN;
      data = JSON.stringify(j);
    } catch {
      /* leave as is */
    }
  }
  const body = Buffer.from(data || '{}', 'utf8');
  const req = http.request(
    {
      host: target.hostname,
      port: target.port || 80,
      path: target.pathname,
      method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': body.length },
      timeout: 1500,
    },
    (res) => {
      res.resume();
      res.on('end', done);
    },
  );
  req.on('error', done); // office not running: ignore
  req.on('timeout', () => req.destroy());
  req.end(body);
});
