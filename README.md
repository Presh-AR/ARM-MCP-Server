# ARM MCP Server

[![CI](https://github.com/AutoRABIT-AI/ARM-MCP-Server/actions/workflows/ci.yml/badge.svg)](https://github.com/AutoRABIT-AI/ARM-MCP-Server/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/@autorabit-ai/arm-mcp-server?logo=npm)](https://www.npmjs.com/package/@autorabit-ai/arm-mcp-server)
[![Node.js 22+](https://img.shields.io/badge/Node.js-22%2B-339933)](https://nodejs.org/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

Model Context Protocol (MCP) server for AutoRABIT ARM Developer APIs. It provides 27 dedicated tools for CI Jobs, nCino CI Jobs, deployment reporting, and SIEM audit logs, plus resources and guided prompts for common workflows.

## Requirements

- Node.js 22 or newer
- An AutoRABIT ARM API token
- A separate audit API token only when using SIEM audit tools

## Quick Start

```bash
git clone https://github.com/AutoRABIT-AI/ARM-MCP-Server.git
cd ARM-MCP-Server
npm ci
npm run build
```

Set the required environment variables:

```bash
export ARM_BASE_URL="https://pilot.autorabit.com"
export ARM_API_TOKEN="YOUR_ARM_API_TOKEN"
```

Run the stdio server:

```bash
npm start
```

After the package is published to npm, it can also be run with:

```bash
npx -y @autorabit-ai/arm-mcp-server
```

## Quick Start Cookbooks

Connect the server to Codex or Claude Code, then run copy-paste-ready workflows for PR readiness, daily deployment reporting, CI failure triage, nCino build health, audit review, and controlled build/deploy actions:

- [ARM MCP Quick Start Cookbooks](docs/cookbooks/README.md)

## MCP Client Configuration

Use the built server from a source checkout:

```json
{
  "mcpServers": {
    "autorabit-arm": {
      "command": "node",
      "args": ["/absolute/path/to/ARM-MCP-Server/dist/index.js"],
      "env": {
        "ARM_BASE_URL": "https://pilot.autorabit.com",
        "ARM_API_TOKEN": "YOUR_ARM_API_TOKEN"
      }
    }
  }
}
```

For npm-based execution, use `npx` as the command and `["-y", "@autorabit-ai/arm-mcp-server"]` as the arguments.

## Configuration

| Variable | Required | Default | Purpose |
| --- | --- | --- | --- |
| `ARM_BASE_URL` | For ARM tools | None | ARM tenant URL. HTTPS is required for non-loopback hosts. |
| `ARM_API_TOKEN` | For ARM tools | None | Token sent in the ARM `token` header. |
| `ARM_TIMEOUT_MS` | No | `30000` | ARM request timeout from 1,000 to 300,000 ms. |
| `ARM_MAX_RETRIES` | No | `2` | Read-request retry count from 0 to 10. |
| `ARM_ENABLE_GENERIC_TOOL` | No | `false` | Exposes the generic `arm_call_api` tool when set to `true`. |
| `ARM_ALLOW_INSECURE_HTTP` | No | `false` | Allows HTTP for non-loopback ARM hosts. Intended only for controlled development. |
| `ARM_AUDIT_BASE_URL` | For audit tools | None | Audit API host. |
| `ARM_AUDIT_API_TOKEN` | For audit tools | None | Bearer token for the audit API. |
| `ARM_AUDIT_TIMEOUT_MS` | No | `30000` | Audit request timeout from 1,000 to 300,000 ms. |
| `ARM_AUDIT_MAX_RETRIES` | No | `2` | Audit read-request retry count from 0 to 10. |
| `ARM_AUDIT_DOWNLOAD_DIR` | No | OS temp directory | Local destination for audit ZIP downloads. |
| `ARM_AUDIT_MAX_DOWNLOAD_BYTES` | No | `52428800` | Maximum accepted audit ZIP size. |

Credentials are read from the process environment and are never accepted as tool arguments. Custom request headers cannot override `token`, `authorization`, `host`, or `content-length`.

## Tools

### CI Jobs v1

| Tool | ARM endpoint |
| --- | --- |
| `arm_list_ci_jobs` | `GET /api/cijobs/v1/listcijobs` |
| `arm_ci_job_history` | `GET /api/cijobs/v1/history/{ciJobName}` |
| `arm_latest_results` | `GET /api/cijobs/v1/latestresults/{ciJobName}` |
| `arm_poll_job_status` | `GET /api/cijobs/v1/pollstatus/{ciJobName}/{buildNumber?}` |
| `arm_rollback_history` | `GET /api/cijobs/v1/rollback/history/{ciJobName}/{buildNumber?}` |
| `arm_rollback_details` | `GET /api/cijobs/v1/rollback/{ciJobName}` |
| `arm_trigger_build` | `POST /api/cijobs/v1/trigger` |
| `arm_update_baseline_revision` | `POST /api/cijobs/v1/update/baselinerevision` |
| `arm_quick_deploy` | `POST /api/cijobs/v1/triggerquickdeploy/{ciJobName}/{buildNumber?}` |
| `arm_start_rollback` | `POST /api/cijobs/v1/rollback` |
| `arm_abort_ci_job` | `PUT /api/cijobs/v1/abort/{ciJobName}/{buildNumber?}` |

CI read tools send path and query parameters without GET request bodies. Mutation tools do not retry automatically.

### nCino CI Jobs v1

| Tool | ARM endpoint |
| --- | --- |
| `arm_ncino_list_ci_jobs` | `GET /api/cijobs/v1/ncino/getalljobs` |
| `arm_ncino_list_job_history` | `GET /api/cijobs/v1/ncino/gethistory` |
| `arm_ncino_trigger_build` | `POST /api/cijobs/v1/ncino/trigger` |
| `arm_ncino_get_build_summary` | `POST /api/cijobs/v1/ncino/getcijobsummary` |
| `arm_ncino_get_latest_build` | `POST /api/cijobs/v1/ncino/getcijobinfo` |
| `arm_ncino_get_build_history` | `POST /api/cijobs/v1/ncino/getcijobbuildhistory` |
| `arm_ncino_poll_build_status` | `POST /api/cijobs/v1/ncino/pollstatus` |

Trigger and monitor an nCino build:

```json
{
  "name": "arm_ncino_trigger_build",
  "arguments": {
    "jobName": "nCino Feature Migration",
    "title": "Release 26.3",
    "deploy": true,
    "commitFeature": false,
    "note": "Triggered from MCP",
    "rollbackEnabled": true,
    "deployedSFOrg": "Production",
    "projectType": "SalesForceFeature"
  }
}
```

```json
{
  "name": "arm_ncino_poll_build_status",
  "arguments": {
    "jobName": "nCino Feature Migration",
    "buildNumber": 42
  }
}
```

### Deployment Reporting v1

| Tool | ARM endpoint |
| --- | --- |
| `arm_list_deployments` | `GET /api/deployments/v1/list` |
| `arm_get_deployment` | `GET /api/deployments/v1/{label}` |
| `arm_get_deployment_components` | `GET /api/deployments/v1/{label}/components` |
| `arm_get_deployment_stories` | `GET /api/deployments/v1/{label}/stories` |
| `arm_get_deployment_promotion_log` | `GET /api/deployments/v1/{label}/logs/{iterationNumber}` |
| `arm_get_deployment_test_coverage` | `GET /api/deployments/v1/{label}/coverage/{iterationNumber}` |

```json
{
  "name": "arm_list_deployments",
  "arguments": {
    "status": "Successful",
    "fromDate": "2026-07-01",
    "toDate": "2026-07-31",
    "destSfOrg": "production@example.com",
    "limit": 25
  }
}
```

### SIEM Audit Logs

| Tool | Audit endpoint |
| --- | --- |
| `arm_audit_get_logs` | `GET /logs/audit_logs` |
| `arm_audit_download_logs` | `GET /logs/audit_logs/download` |
| `arm_audit_list_event_types` | Local reference, no API call |

Audit downloads enforce a configurable byte limit, write files with owner-only permissions, and return an MCP `resource_link` to the local ZIP. Download ranges cannot exceed 90 days.

### Optional Generic Tool

`arm_call_api` supports additional same-origin `/api/` endpoints. It is hidden and blocked by default because it expands the server's action surface. Set `ARM_ENABLE_GENERIC_TOOL=true` only when the MCP client needs unmodeled endpoints.

## Resources

- `arm://docs/overview`
- `arm://docs/cijobs-v1`
- `arm://docs/ncino-cijobs-v1`
- `arm://docs/deployments-v1`
- `arm://docs/auth`
- `arm://docs/audit-logs`

## Prompts

- `arm_quick_deploy_guide`
- `arm_rollback_guide`
- `arm_trigger_build_guide`
- `arm_poll_status_guide`
- `arm_deployment_report_guide`
- `arm_ncino_build_and_monitor_guide`
- `arm_ncino_build_report_guide`
- `arm_audit_logs_guide`

## Docker

```bash
docker build -t arm-mcp-server .
docker run -i --rm \
  -e ARM_BASE_URL \
  -e ARM_API_TOKEN \
  arm-mcp-server
```

For Docker Compose:

```bash
cp .env.example .env
docker compose run --rm arm-mcp-server
```

## Development

```bash
npm ci
npm run typecheck
npm test
npm audit
npm pack --dry-run
```

Contract tests launch the compiled MCP server over stdio and verify tool discovery, resources, prompts, authentication headers, HTTP methods, paths, payloads, error signaling, and security controls against a local mock server.

See [CONTRIBUTING.md](CONTRIBUTING.md) for contribution requirements, [SECURITY.md](SECURITY.md) for private vulnerability reporting, and [SUPPORT.md](SUPPORT.md) for support channels.

## API Sources

- [AutoRABIT ARM Developer API references](https://knowledgebase.autorabit.com/product-guides/arm/introduction-to-arm-developer-apis/api-references)
- [AutoRABIT CI Jobs Postman documentation](https://documenter.getpostman.com/view/7212585/UVkvHBtD)
- [AutoRABIT nCino API references](https://knowledgebase.autorabit.com/product-guides/arm/arm-features/ncino/developer-apis/api-references)
- [AutoRABIT nCino Postman documentation](https://documenter.getpostman.com/view/35959276/2sA3QwdAaS)
- [AutoRABIT Deployment Postman documentation](https://documenter.getpostman.com/view/46841090/2sBY4HSNpN)

## License

[MIT](LICENSE)
