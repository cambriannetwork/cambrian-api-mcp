#!/usr/bin/env node
// Finishes a version bump that `npm version <type> --no-git-tag-version` started:
// copies the package.json version into server.json and turns [Unreleased] into a
// dated CHANGELOG section that names the cambrian release it requires.
// Usage: node scripts/release-bump.mjs <cambrian-version> [date]

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const UNRELEASED = '## [Unreleased]';

export function releaseChangelog(changelog, version, cambrian, date) {
  const start = changelog.indexOf(UNRELEASED);
  if (start === -1) throw new Error('CHANGELOG.md has no [Unreleased] section.');
  if (changelog.includes(`## [${version}]`)) throw new Error(`CHANGELOG.md already has ${version}.`);
  const bodyStart = start + UNRELEASED.length;
  const next = changelog.indexOf('\n## ', bodyStart);
  const end = next === -1 ? changelog.length : next;
  const pending = changelog.slice(bodyStart, end)
    .replace(/^- Requires `cambrian` \^[^\n]*\n?/gm, '')
    .trim();
  const requirement = `### Dependencies\n\n- Requires \`cambrian\` ^${cambrian}. Tool names, chains, and ` +
    'validation come from that release; see the ' +
    '[cambrian changelog](https://github.com/cambriannetwork/cambrian-cli/blob/main/CHANGELOG.md).';
  const body = pending ? `${pending}\n\n${requirement}` : requirement;
  return `${changelog.slice(0, start)}${UNRELEASED}\n\n## [${version}] - ${date}\n\n${body}\n${changelog.slice(end)}`;
}

export function releaseServerJson(server, version) {
  return {
    ...server,
    version,
    packages: server.packages.map((entry) =>
      entry.identifier === 'cambrian-api-mcp' ? { ...entry, version } : entry),
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [cambrian, date = new Date().toISOString().slice(0, 10)] = process.argv.slice(2);
  if (!/^\d+\.\d+\.\d+$/.test(cambrian ?? '')) throw new Error('Usage: release-bump.mjs <cambrian-version> [date]');
  const root = resolve(fileURLToPath(import.meta.url), '../..');
  const read = (file) => readFileSync(resolve(root, file), 'utf8');
  const { version } = JSON.parse(read('package.json'));
  writeFileSync(resolve(root, 'server.json'), `${JSON.stringify(releaseServerJson(JSON.parse(read('server.json')), version), null, 2)}\n`);
  writeFileSync(resolve(root, 'CHANGELOG.md'), releaseChangelog(read('CHANGELOG.md'), version, cambrian, date));
  console.log(version);
}
