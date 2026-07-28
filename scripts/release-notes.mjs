#!/usr/bin/env node

import { readFileSync } from 'fs';
import { join, resolve } from 'path';

const repoRoot = resolve(process.argv[2] ?? process.cwd());
const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'));
const changelog = readFileSync(join(repoRoot, 'CHANGELOG.md'), 'utf8');
const version = pkg.version;
const heading = `## [${version}]`;
const start = changelog.indexOf(heading);

if (start === -1) {
  console.log(`Release ${version}`);
  console.log('');
  console.log('See CHANGELOG.md for details.');
  process.exit(0);
}

const afterHeading = changelog.indexOf('\n', start);
const next = changelog.indexOf('\n## ', afterHeading + 1);
const section = changelog
  .slice(afterHeading + 1, next === -1 ? changelog.length : next)
  .trim();

console.log(section.length > 0 ? section : `Release ${version}`);
