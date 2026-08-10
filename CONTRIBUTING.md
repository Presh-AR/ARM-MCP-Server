# Contributing

Contributions are welcome through GitHub pull requests.

## Development Setup

Use Node.js 22 or newer.

```bash
npm ci
npm run typecheck
npm test
```

Tests use local mock HTTP servers and do not require AutoRABIT credentials.

## API Contract Changes

For each new or changed ARM endpoint:

1. Link the published AutoRABIT knowledge-base or Postman contract in the pull request.
2. Add or update the dedicated MCP tool schema, annotations, resource documentation, and workflow prompts where useful.
3. Add a contract test covering the exact HTTP method, path, query, body, and authentication header.
4. Keep mutating operations non-retryable unless the ARM API provides an idempotency contract.
5. Never add credentials, tenant-specific values, customer data, or captured production responses.

## Pull Requests

Before opening a pull request, run:

```bash
npm run typecheck
npm test
npm audit
npm pack --dry-run
docker build -t arm-mcp-server .
```

Keep changes focused and update `CHANGELOG.md` for user-visible behavior.
