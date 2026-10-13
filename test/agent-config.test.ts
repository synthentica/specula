// Claude Code and Codex must load the same skill and the same chrome-devtools-mcp setup.

import assert from 'node:assert/strict';
import { readFile, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';

const root = join(import.meta.dirname, '..');

test('Codex finds the skill through .agents/skills', async () => {
  assert.equal(
    await realpath(join(root, '.agents/skills/specula')),
    await realpath(join(root, '.claude/skills/specula')),
  );
  const skill = await readFile(join(root, '.agents/skills/specula/SKILL.md'), 'utf8');
  assert.match(skill, /^---\nname: specula\n/);
});

test('.codex/config.toml starts chrome-devtools-mcp like .mcp.json', async () => {
  const mcp = JSON.parse(await readFile(join(root, '.mcp.json'), 'utf8')).mcpServers['chrome-devtools'];
  const toml = await readFile(join(root, '.codex/config.toml'), 'utf8');
  const section = toml.split('[mcp_servers.chrome-devtools]')[1];
  assert.ok(section, 'missing [mcp_servers.chrome-devtools]');
  const command = /^command = "([^"]*)"/m.exec(section)?.[1];
  const args = [...(/^args = \[([\s\S]*?)\]/m.exec(section)?.[1] ?? '').matchAll(/"([^"]*)"/g)].map((m) => m[1]);
  assert.equal(command, mcp.command);
  assert.deepEqual(args, mcp.args);
});
