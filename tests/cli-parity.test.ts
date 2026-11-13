import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { listMcpTools } from '../src/server.js';

/**
 * The CLI is the source of truth. Its own self-description (`cambrian describe
 * opencli`) must match the MCP tool list: one tool per data command, with the
 * same parameters and the same required flags. The CLI's MCP contract job runs
 * this test against every CLI build, so a CLI change that the MCP does not
 * follow fails the CLI release.
 */

/** CLI command groups with no MCP tool, by design. */
const CLI_ONLY = new Set(['pay', 'docs', 'config', 'completion', 'schema', 'skill', 'mcp', 'describe']);
/** MCP tools with no CLI command, by design. */
const MCP_ONLY = new Set(['cambrian_docs', 'cambrian_solana_token_snapshot']);

interface OpenCliCommand {
  name: string;
  options?: Array<{ name: string; required?: boolean }>;
  commands?: OpenCliCommand[];
}

function cliCommands(): Map<string, Map<string, boolean>> {
  const require = createRequire(import.meta.url);
  const pkgPath = require.resolve('cambrian/package.json');
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { bin: Record<string, string> };
  const home = mkdtempSync(join(tmpdir(), 'cambrian-parity-'));
  try {
    const out = execFileSync(process.execPath, [join(dirname(pkgPath), pkg.bin.cambrian), 'describe', 'opencli'], {
      encoding: 'utf8',
      env: { PATH: process.env.PATH, HOME: home, CAMBRIAN_SCHEMA_MODE: 'bundled' },
    });
    const commands = new Map<string, Map<string, boolean>>();
    for (const group of (JSON.parse(out) as { commands: OpenCliCommand[] }).commands) {
      if (CLI_ONLY.has(group.name) || !group.commands?.length) continue;
      for (const command of group.commands) {
        const name = `cambrian_${group.name}_${command.name}`.replace(/[-/]/g, '_');
        const options = (command.options ?? []).map((option) => [option.name.replace(/-/g, '_'), option.required === true] as const);
        commands.set(name, new Map(options));
      }
    }
    return commands;
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

function mcpTools(): Map<string, Map<string, boolean>> {
  const tools = new Map<string, Map<string, boolean>>();
  for (const tool of listMcpTools()) {
    if (MCP_ONLY.has(tool.name)) continue;
    const schema = tool.inputSchema as { properties?: Record<string, unknown>; required?: string[] };
    const required = new Set(schema.required ?? []);
    const params = Object.keys(schema.properties ?? {})
      .filter((name) => !name.startsWith('_'))
      .map((name) => [name, required.has(name)] as const);
    tools.set(tool.name, new Map(params));
  }
  return tools;
}

describe('CLI parity', () => {
  const cli = cliCommands();
  const mcp = mcpTools();

  it('exposes exactly one MCP tool per CLI data command', () => {
    expect(cli.size).toBeGreaterThan(100);
    expect([...mcp.keys()].sort()).toEqual([...cli.keys()].sort());
  });

  it('gives each tool the CLI command parameters and required flags', () => {
    const differences: string[] = [];
    for (const [name, options] of cli) {
      const params = mcp.get(name);
      if (!params) continue;
      for (const [option, required] of options) {
        if (!params.has(option)) differences.push(`${name}: missing ${option}`);
        else if (params.get(option) !== required) differences.push(`${name}: ${option} required cli=${required} mcp=${params.get(option)}`);
      }
      for (const param of params.keys()) {
        if (!options.has(param)) differences.push(`${name}: extra ${param}`);
      }
    }
    expect(differences).toEqual([]);
  });
});
