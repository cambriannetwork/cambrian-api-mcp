import { describe, expect, it } from 'vitest';
// @ts-expect-error plain .mjs script without type declarations
import { releaseChangelog, releaseServerJson } from '../scripts/release-bump.mjs';

const changelog = `# Changelog

## [Unreleased]

### Changed

- Something new.
- Requires \`cambrian\` ^1.9.1.

## [1.8.1] - 2026-10-06

- Old.
`;

describe('release-bump', () => {
  it('dates [Unreleased], keeps its notes, and replaces the cambrian requirement', () => {
    const out = releaseChangelog(changelog, '1.9.0', '1.10.0', '2026-10-08');
    expect(out).toContain('## [Unreleased]\n\n## [1.9.0] - 2026-10-08\n\n### Changed\n\n- Something new.\n\n### Dependencies');
    expect(out).toContain('- Requires `cambrian` ^1.10.0.');
    expect(out).not.toContain('^1.9.1');
    expect(out).toContain('\n\n## [1.8.1] - 2026-10-06\n\n- Old.\n');
    expect(() => releaseChangelog(out, '1.9.0', '1.10.0', '2026-10-08')).toThrow('already has 1.9.0');
  });

  it('writes only a requirement when nothing else is unreleased', () => {
    const out = releaseChangelog('## [Unreleased]\n\n## [1.0.0] - 2026-01-01\n', '1.0.1', '1.10.1', '2026-10-09');
    expect(out).toBe('## [Unreleased]\n\n## [1.0.1] - 2026-10-09\n\n### Dependencies\n\n- Requires `cambrian` ^1.10.1. ' +
      'Tool names, chains, and validation come from that release; see the ' +
      '[cambrian changelog](https://github.com/cambriannetwork/cambrian-cli/blob/main/CHANGELOG.md).\n\n## [1.0.0] - 2026-01-01\n');
  });

  it('sets the server and npm package versions in server.json', () => {
    const server = { version: '1.8.1', packages: [{ identifier: 'cambrian-api-mcp', version: '1.8.1' }, { identifier: 'other', version: '9' }] };
    expect(releaseServerJson(server, '1.9.0')).toEqual({
      version: '1.9.0',
      packages: [{ identifier: 'cambrian-api-mcp', version: '1.9.0' }, { identifier: 'other', version: '9' }],
    });
  });
});
