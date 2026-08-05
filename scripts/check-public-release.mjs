#!/usr/bin/env node

import { existsSync, readdirSync, readFileSync, statSync } from 'fs';
import { basename, join, relative, resolve } from 'path';
import { spawnSync } from 'child_process';

const repoRoot = resolve(process.argv[2] ?? process.cwd());
const dot = '.';
const hidden = (name) => `${dot}${name}`;
const text = (...parts) => parts.join('');
const relPath = (...parts) => parts.join('/');

const forbiddenPaths = [
  hidden('claude'),
  hidden('agents'),
  hidden('codex'),
  text('AGENTS', '.md'),
  text('CLAUDE', '.md'),
  text('CLAUDE_CODE_', 'CONFIG.md'),
  text('WIF_', 'MIGRATION.md'),
  text('claude-config-', 'example.md'),
  'Dockerfile',
  relPath(hidden('github'), 'workflows', 'deploy.yml'),
];

const forbiddenTerms = [
  text('cambrian', '_api_', 'mcp'),
  text('api_', 'mcp'),
  text('not yet ', 'published'),
  text('temporary ', 'launch URL'),
  text('68', '+ total'),
  text('68', '+ DeFi Tools'),
  text('cambrian-mcp-', 'verisense'),
  text('cambrian-mcp-server-prod-', '981646676182.us-central1.run.app'),
];

const skipDirs = new Set(['.git']);
const failures = [];
const trackedPaths = new Set(loadTrackedPaths());

function normalize(path) {
  return path.split('\\').join('/');
}

function fail(message) {
  failures.push(message);
}

function loadTrackedPaths() {
  const result = spawnSync('git', ['ls-files', '-z'], {
    cwd: repoRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  if (result.status !== 0 || !result.stdout) return [];
  return result.stdout.split('\0').filter(Boolean).map(normalize);
}

function hasTrackedPath(rel) {
  const normalized = normalize(rel);
  return trackedPaths.has(normalized) || [...trackedPaths].some((path) => path.startsWith(`${normalized}/`));
}

function isForbiddenEnv(rel) {
  return rel === hidden('env') || rel.startsWith(`${hidden('env')}.`);
}

function isForbiddenPath(rel) {
  const normalized = normalize(rel);
  if (isForbiddenEnv(normalized)) return true;
  return forbiddenPaths.some((forbidden) => {
    const path = normalize(forbidden);
    return normalized === path || normalized.startsWith(`${path}/`);
  });
}

function isTextFile(path) {
  const bytes = readFileSync(path);
  return !bytes.subarray(0, 4096).includes(0);
}

function walk(dir, visit) {
  for (const entry of readdirSync(dir)) {
    if (skipDirs.has(entry)) continue;
    const abs = join(dir, entry);
    const rel = normalize(relative(repoRoot, abs));
    visit(abs, rel);
    if (statSync(abs).isDirectory() && !isForbiddenPath(rel)) {
      walk(abs, visit);
    }
  }
}

if (!existsSync(join(repoRoot, 'package.json'))) {
  fail(`No package.json found at ${repoRoot}`);
}

walk(repoRoot, (abs, rel) => {
  if (basename(abs) === '.DS_Store') {
    fail(`Forbidden Finder metadata file: ${rel}`);
    return;
  }
  if (rel === 'node_modules' || rel.startsWith('node_modules/')) {
    if (hasTrackedPath('node_modules')) {
      fail('Forbidden tracked dependency directory: node_modules');
    }
    return;
  }
  if (isForbiddenPath(rel)) {
    fail(`Forbidden internal path: ${rel}`);
    return;
  }
  if (!statSync(abs).isFile() || !isTextFile(abs)) return;
  const body = readFileSync(abs, 'utf8');
  for (const term of forbiddenTerms) {
    if (body.includes(term)) {
      fail(`Forbidden internal marker "${term}" in ${rel}`);
    }
  }
});

const pkgPath = join(repoRoot, 'package.json');
const serverPath = join(repoRoot, 'server.json');

if (existsSync(pkgPath)) {
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
  const publicRepo = 'git+https://github.com/cambriannetwork/cambrian-api-mcp.git';
  const publicHome = 'https://github.com/cambriannetwork/cambrian-api-mcp#readme';
  const publicBugs = 'https://github.com/cambriannetwork/cambrian-api-mcp/issues';
  if (pkg.repository?.url !== publicRepo) fail(`package.json repository.url must be ${publicRepo}`);
  if (pkg.homepage !== publicHome) fail(`package.json homepage must be ${publicHome}`);
  if (pkg.bugs?.url !== publicBugs) fail(`package.json bugs.url must be ${publicBugs}`);
  if (pkg.dependencies?.cambrian !== '^1.1.7') fail('package.json must depend on cambrian@^1.1.7');
  if (pkg.scripts?.ci !== 'npm test && npm run build') {
    fail('package.json scripts.ci must be "npm test && npm run build"');
  }
  if (pkg.scripts?.['check:public'] !== 'node scripts/check-public-release.mjs') {
    fail('package.json scripts.check:public must run scripts/check-public-release.mjs');
  }
  if (!Array.isArray(pkg.files) || pkg.files.length !== 1 || pkg.files[0] !== 'dist/') {
    fail('package.json files must be exactly ["dist/"]');
  }
}

if (existsSync(pkgPath) && existsSync(serverPath)) {
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
  const server = JSON.parse(readFileSync(serverPath, 'utf8'));
  if (pkg.mcpName !== server.name) fail('package.json mcpName must match server.json name');
  if (pkg.version !== server.version) fail('package.json version must match server.json version');
  if (server.repository?.url !== 'https://github.com/cambriannetwork/cambrian-api-mcp') {
    fail('server.json repository.url must point to the public hyphenated repo');
  }
  const npmPackage = server.packages?.find((entry) => entry.registryType === 'npm');
  if (!npmPackage) {
    fail('server.json must declare the npm package');
  } else {
    if (npmPackage.identifier !== 'cambrian-api-mcp') fail('server.json npm identifier must be cambrian-api-mcp');
    if (npmPackage.version !== pkg.version) fail('server.json npm package version must match package.json version');
  }
  for (const remote of server.remotes ?? []) {
    if (remote.type !== 'streamable-http') fail('server.json remotes must use streamable-http');
    if (typeof remote.url !== 'string' || !remote.url.startsWith('https://') || !remote.url.endsWith('/mcp')) {
      fail('server.json remote URLs must be HTTPS /mcp endpoints');
    }
    if (remote.url.includes('/sse')) fail('server.json remote URLs must not use legacy SSE endpoints');
  }
}

if (failures.length > 0) {
  for (const failure of failures) {
    console.error(`public-release-check: ${failure}`);
  }
  process.exit(1);
}

console.log(`public-release-check: passed for ${repoRoot}`);
