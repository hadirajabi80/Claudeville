#!/usr/bin/env node
// Adds (or with --uninstall removes) the Agent Office hooks in ~/.claude/settings.json.
// Existing settings are preserved; a timestamped backup is written first.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const MARKER = 'claude-agent-office/hooks/relay.mjs';
const here = path.dirname(fileURLToPath(import.meta.url));
const relay = path.resolve(here, '..', 'hooks', 'relay.mjs').replace(/\\/g, '/');
const settingsPath = path.join(os.homedir(), '.claude', 'settings.json');
const uninstall = process.argv.includes('--uninstall');

const TOOL_EVENTS = ['PreToolUse', 'PostToolUse', 'PostToolUseFailure'];
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

const raw = fs.existsSync(settingsPath) ? fs.readFileSync(settingsPath, 'utf8') : '{}';
const settings = JSON.parse(raw || '{}');
fs.writeFileSync(`${settingsPath}.agent-office-backup-${Date.now()}`, raw);

settings.hooks ??= {};
const isOurs = (entry) => (entry.hooks ?? []).some((h) => String(h.command ?? '').includes(MARKER));

for (const ev of EVENTS) {
  const list = (settings.hooks[ev] ?? []).filter((e) => !isOurs(e));
  if (!uninstall) {
    const entry = { hooks: [{ type: 'command', command: `node "${relay}"`, async: true, timeout: 5 }] };
    if (TOOL_EVENTS.includes(ev)) entry.matcher = '*';
    list.push(entry);
  }
  if (list.length) settings.hooks[ev] = list;
  else delete settings.hooks[ev];
}
if (!Object.keys(settings.hooks).length) delete settings.hooks;

fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n');
console.log(
  uninstall
    ? `Removed Agent Office hooks from ${settingsPath}`
    : `Installed Agent Office hooks for ${EVENTS.length} events in ${settingsPath}\nRelay: ${relay}`,
);
