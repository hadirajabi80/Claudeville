#!/usr/bin/env node
// Claude Code hook for questions (AskUserQuestion) and permission prompts (PermissionRequest).
// It hands the question to Claudeville and waits for you to answer it there, then returns the
// answer to Claude Code. If Claudeville is not open in a visible tab (or you don't answer in time,
// or you choose "answer in Claude Code"), it prints nothing and Claude Code asks you as usual.
import http from 'node:http';

if (process.env.AGENT_OFFICE_SKIP) process.exit(0);

const target = new URL(process.env.AGENT_OFFICE_ASK_URL || 'http://127.0.0.1:5199/api/ask');
const quit = () => process.exit(0);
setTimeout(quit, 590_000).unref(); // never outlive the hook timeout

let data = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => (data += c));
process.stdin.on('error', quit);
process.stdin.on('end', () => {
  let payload;
  try {
    payload = JSON.parse(data || '{}');
  } catch {
    return quit();
  }
  if (process.env.AGENT_OFFICE_RUN) payload.office_run = process.env.AGENT_OFFICE_RUN;
  const body = Buffer.from(JSON.stringify(payload), 'utf8');
  const req = http.request(
    {
      host: target.hostname,
      port: target.port || 80,
      path: target.pathname,
      method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': body.length },
    },
    (res) => {
      let out = '';
      res.setEncoding('utf8');
      res.on('data', (c) => (out += c));
      res.on('end', () => {
        try {
          const j = JSON.parse(out || '{}');
          // only print a real hook decision; an empty object means "let Claude Code ask normally"
          if (j && j.hookSpecificOutput) process.stdout.write(JSON.stringify(j));
        } catch {
          /* ignore */
        }
        quit();
      });
    },
  );
  req.on('error', quit); // office not running
  req.end(body);
});
