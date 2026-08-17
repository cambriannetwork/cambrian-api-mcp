# Release Checklist

This public repository is the npm provenance release surface for `cambrian-api-mcp`.

## Verify

```bash
npm ci
npm audit --audit-level=moderate
npm run check:public
npm test
npm run build
node dist/index.js --version
npm pack --dry-run
```

Confirm the dry-run package includes `dist/index.js` and `dist/server.js`, and excludes `src/`, `tests/`, deployment workflows, Docker files, and `.env*` files.

## Publish

Confirm `NPM_TOKEN` and the `npm-production` environment are configured, then
push the version tag from this public repository:

```bash
version="v$(node -p "require('./package.json').version")"
git tag "$version"
git push origin main "$version"
```

The tag-triggered release workflow repeats verification and publishes with npm
provenance. It then publishes the matching MCP Registry version and creates the
GitHub release. Do not publish npm or Registry metadata manually.

Then verify:

```bash
npm view cambrian-api-mcp version dist-tags repository.url homepage bugs.url
npx -y cambrian-api-mcp@latest --version
version="$(node -p "require('./server.json').version")"
curl --fail \
  "https://registry.modelcontextprotocol.io/v0.1/servers/io.github.cambriannetwork%2Fcambrian-api/versions/$version"
```

Each MCP Registry version is immutable.
