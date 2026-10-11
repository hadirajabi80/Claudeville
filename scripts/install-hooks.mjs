#!/usr/bin/env node
// Adds (or with --uninstall removes) the Claudeville hooks in ~/.claude/settings.json.
// Existing settings are preserved; a timestamped backup is written first.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const MARKER = 'claude-agent-office/hooks/';
const here = path.dirname(fileURLToPath(import.meta.url));
const relay = path.resolve(here, '..', 'hooks', 'relay.mjs').replace(/\\/g, '/');
const askHook = path.resolve(here, '..', 'hooks', 'ask.mjs').replace(/\\/g, '/');
const settingsPath = path.join(os.homedir(), '.claude', 'settings.json');
const uninstall = process.argv.includes('--uninstall');

const TOOL_EVENTS = ['PreToolUse', 'PostToolUse', 'PostToolUseFailure'];
// fire-and-forget activity events (async: they never slow Claude down)
const EVENTS = [
  'SessionStart',
  'SessionEnd',
  'UserPromptSubmit',
  'Stop',
  'StopFailure',
  'SubagentStart',
  'SubagentStop',
  'Notification',
  ...TOOL_EVENTS,
];
// questions and permission prompts you can answer in the office: these hooks wait for your answer
// (only while Claudeville is open in a visible tab; otherwise they return at once)
const ASK_HOOKS = [
  { event: 'PermissionRequest', matcher: '*' },
  { event: 'PreToolUse', matcher: 'AskUserQuestion' },
];

const raw = fs.existsSync(settingsPath) ? fs.readFileSync(settingsPath, 'utf8') : '{}';
const settings = JSON.parse(raw || '{}');
fs.writeFileSync(`${settingsPath}.agent-office-backup-${Date.now()}`, raw);

settings.hooks ??= {};
const isOurs = (entry) => (entry.hooks ?? []).some((h) => String(h.command ?? '').replace(/\\/g, '/').includes(MARKER));

for (const ev of new Set([...EVENTS, ...ASK_HOOKS.map((a) => a.event)])) {
  const list = (settings.hooks[ev] ?? []).filter((e) => !isOurs(e));
  if (!uninstall) {
    if (EVENTS.includes(ev)) {
      const entry = { hooks: [{ type: 'command', command: `node "${relay}"`, async: true, timeout: 5 }] };
      if (TOOL_EVENTS.includes(ev)) entry.matcher = '*';
      list.push(entry);
    }
    for (const a of ASK_HOOKS.filter((x) => x.event === ev)) {
      list.push({ matcher: a.matcher, hooks: [{ type: 'command', command: `node "${askHook}"`, timeout: 600 }] });
    }
  }
  if (list.length) settings.hooks[ev] = list;
  else delete settings.hooks[ev];
}
if (!Object.keys(settings.hooks).length) delete settings.hooks;

fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n');
console.log(
  uninstall
    ? `Removed Claudeville hooks from ${settingsPath}`
    : `Installed Claudeville hooks in ${settingsPath}\nActivity relay: ${relay}\nQuestions & permissions: ${askHook}`,
);
