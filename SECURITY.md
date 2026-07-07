# Security

## Reporting a Vulnerability

Please report security issues privately by emailing the maintainers or by opening a private security advisory in GitHub.

Do not open a public issue for vulnerabilities involving credential handling, package publishing, hosted MCP infrastructure, or API authentication.

## Credential Handling

- Local stdio mode reads `CAMBRIAN_API_KEY` from the process environment.
- Hosted HTTP mode requires `Authorization: Bearer <CAMBRIAN_API_KEY>` or `X-Cambrian-Api-Key`.
- The public package is BYOK only and must not embed or proxy a shared Cambrian API key.
- The package does not require `.env` files and the public release check rejects `.env*` paths.

Never include real API keys, bearer tokens, private headers, or production request payloads in issues, logs, tests, docs, or screenshots.
