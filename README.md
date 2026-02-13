# ARM MCP Server

[![CI](https://github.com/Presh-AR/ARM-MCP-Server/actions/workflows/ci.yml/badge.svg)](https://github.com/Presh-AR/ARM-MCP-Server/actions/workflows/ci.yml)

MCP server for AutoRABIT ARM APIs, currently modeled for CI Jobs v1 endpoints.

**Project status:** The badge above reflects the latest run of [CI](https://github.com/Presh-AR/ARM-MCP-Server/actions/workflows/ci.yml) on `main` (install, build, and type check). Green = passing, red = failing.

## Modeled APIs

- `POST /api/cijobs/v1/triggerquickdeploy/{ciJobName}/{buildNumber?}`
- `POST /api/cijobs/v1/rollback`
- `PUT /api/cijobs/v1/abort/{ciJobName}/{buildNumber?}`

## MCP Tools

- `arm_quick_deploy`
- `arm_start_rollback`
- `arm_abort_ci_job`
- `arm_call_api` (generic fallback)

## MCP Resources

- `arm://docs/overview`
- `arm://docs/cijobs-v1`
- `arm://docs/auth`

## MCP Prompts

- `arm_quick_deploy_guide`
- `arm_rollback_guide`

## Authentication

ARM expects an API token in a `token` header.

Required env vars:

- `ARM_BASE_URL` (example: `pilot.autorabit.com` or `https://pilot.autorabit.com`)
- `ARM_API_TOKEN`

Optional env vars:

- `ARM_TIMEOUT_MS` (default `30000`)
- `ARM_MAX_RETRIES` (default `2`)

## Setup

```bash
npm install
cp .env.example .env
# edit .env
npm run build
```

## Run

```bash
npm run dev
```

or production:

```bash
npm run build
npm start
```

## MCP client config (stdio)

```json
{
  "mcpServers": {
    "arm": {
      "command": "node",
      "args": ["/absolute/path/to/arm-mcp-server/dist/index.js"],
      "env": {
        "ARM_BASE_URL": "pilot.autorabit.com",
        "ARM_API_TOKEN": "YOUR_TOKEN"
      }
    }
  }
}
```

## Tool payloads

### `arm_quick_deploy`

```json
{
  "ciJobName": "BuildOnCommitNoRevision",
  "buildNumber": 7,
  "projectName": "MyProject",
  "title": "Release 1.2.3"
}
```

### `arm_start_rollback`

```json
{
  "projectName": "MyProject",
  "title": "Release 1.2.3"
}
```

### `arm_abort_ci_job`

```json
{
  "ciJobName": "BuildOnCommitNoRevision",
  "buildNumber": 7,
  "projectName": "MyProject",
  "title": "Release 1.2.3"
}
```
