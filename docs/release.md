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

Publish from this public repository only:

```bash
npm publish --provenance --access public
```

Then verify:

```bash
npm view cambrian-api-mcp version dist-tags repository.url homepage bugs.url
npx -y cambrian-api-mcp@latest --version
```
