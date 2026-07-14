# Contributing

PlanForge is an early preview. Focused bug reports and small, test-backed pull
requests are welcome.

## Development setup

```bash
npm ci
npm run verify
npm run scan:public
```

Use Node.js 20 or newer. Tests must not launch real Claude or Codex processes,
make network calls, merge real repositories, or write into a user's live
runtime root.

## Pull requests

- Keep one behavioral change per pull request.
- Add or update a test for observable behavior.
- Preserve target allowlisting, subscription-auth guards, protected-file
  scopes, independent verification, and `--ff-only` merge behavior.
- Explain the trust-boundary impact of changes to process spawning, filesystem
  access, HTTP/MCP routes, or verifier execution.
- Run the full verification and public-safety scan before requesting review.
