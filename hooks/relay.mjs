#!/usr/bin/env node
// Hook relay: forwards the hook JSON (stdin) to Claudeville.
// Used by Claude Code (default) and by Cursor (`--source=cursor`).
// It never blocks or changes the agent's behavior: it exits 0 and prints nothing, except for
// Cursor's beforeSubmitPrompt, which needs an explicit "continue" answer.
// Uses node:http directly (not fetch) so proxy environment variables never reroute localhost.
import http from 'node:http';

// Chat answers are produced by short claude runs started by the office itself: never show those as agents.
if (process.env.AGENT_OFFICE_SKIP) process.exit(0);

const source = (process.argv.find((a) => a.startsWith('--source=')) ?? '').slice(9) || 'claude';
const target = new URL(process.env.AGENT_OFFICE_URL || 'http://127.0.0.1:5199/api/event');
const done = () => process.exit(0);
setTimeout(done, 3000).unref();

let data = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => (data += c));
process.stdin.on('error', done);
process.stdin.on('end', () => {
  let payload = null;
  try {
    payload = JSON.parse(data || '{}');
  } catch {
    /* forward as is */
  }
  if (payload && typeof payload === 'object') {
    // Cursor waits for an answer on this event: let the prompt through unchanged
    if (source === 'cursor' && payload.hook_event_name === 'beforeSubmitPrompt') process.stdout.write(JSON.stringify({ continue: true }));
    if (source !== 'claude') payload.office_source = source;
    // tasks started from the office carry their run id, so the office knows which character is doing them
    if (process.env.AGENT_OFFICE_RUN) payload.office_run = process.env.AGENT_OFFICE_RUN;
    data = JSON.stringify(payload);
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
