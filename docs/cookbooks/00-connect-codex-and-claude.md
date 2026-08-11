# Connect ARM MCP to Codex or Claude Code

Outcome: a verified, local ARM MCP connection without placing an ARM token in version control.

Time: about 10 minutes after you have an ARM API token.

## 1. Build the server

Requirements:

- Node.js 22 or newer
- An AutoRABIT ARM tenant URL
- An ARM API token

From the server checkout:

```bash
cd "/absolute/path/to/ARM-MCP-Server"
npm ci
npm run build
```

Set credentials in the shell that will launch Codex or Claude Code:

```bash
export ARM_MCP_SERVER_PATH="/absolute/path/to/ARM-MCP-Server"
export ARM_BASE_URL="https://your-tenant.autorabit.com"
export ARM_API_TOKEN="replace-with-your-token"
```

Use the tenant origin only. Do not append an ARM API path.

Current distribution note, verified 2026-08-11: `@autorabit-ai/arm-mcp-server` is not available from the public npm registry. Use the source-build path above. Replace this note with the `npx` path after publication is verified.

## 2A. Connect Codex

Codex reads global MCP configuration from `~/.codex/config.toml` and project configuration from `.codex/config.toml` in a trusted project. Add this block to either file:

```toml
[mcp_servers.autorabit-arm]
command = "node"
args = ["/absolute/path/to/ARM-MCP-Server/dist/index.js"]
env_vars = ["ARM_BASE_URL", "ARM_API_TOKEN"]
required = true
default_tools_approval_mode = "writes"
startup_timeout_sec = 20
tool_timeout_sec = 120
```

The `env_vars` setting forwards the two variables from the shell environment. It keeps their values out of the TOML file.

Verify:

```bash
codex mcp list
codex
```

Inside Codex, run `/mcp` and confirm `autorabit-arm` is active.

If you prefer the UI, open MCP server settings in the ChatGPT desktop app or Codex IDE extension, add a STDIO server with command `node` and the absolute `dist/index.js` argument, save, and restart that client.

## 2B. Connect Claude Code

Create `.mcp.json` at the root of the project where you will use Claude Code:

```json
{
  "mcpServers": {
    "autorabit-arm": {
      "type": "stdio",
      "command": "node",
      "args": ["${ARM_MCP_SERVER_PATH}/dist/index.js"],
      "env": {
        "ARM_BASE_URL": "${ARM_BASE_URL}",
        "ARM_API_TOKEN": "${ARM_API_TOKEN}"
      }
    }
  }
}
```

The placeholders are environment-variable references. Do not replace them with secrets in a file that will be committed.

Verify:

```bash
claude mcp list
claude
```

The first interactive launch may ask you to trust the workspace and approve the project-scoped server. Inside Claude Code, run `/mcp` and confirm the server is connected.

Claude Code can expose ARM MCP prompts as commands and ARM resources through its resource picker. Type `/` or `@` and select the dynamically discovered entry. The full natural-language prompts in this cookbook remain the portable path across both clients.

## 3. Run a read-only smoke test

Paste this prompt into Codex or Claude Code:

```text
Use only the `autorabit-arm` MCP server.

1. Call `arm_list_ci_jobs`.
2. Return the first five exact, case-sensitive CI job names in a table.
3. State the MCP tool used and whether the call succeeded.
4. If authentication, transport, or server startup fails, report the exact error and stop.

Do not call any mutation tool.
```

Success means the client returns real CI job data from the target tenant. A connected status proves process startup; the smoke test proves an authenticated ARM request.

## 4. Optional audit configuration

The audit tools use a separate host and bearer token. Add these variables only when you need the audit cookbook:

```bash
export ARM_AUDIT_BASE_URL="https://your-audit-host.example.com"
export ARM_AUDIT_API_TOKEN="replace-with-your-audit-token"
```

For Codex, extend `env_vars`:

```toml
env_vars = [
  "ARM_BASE_URL",
  "ARM_API_TOKEN",
  "ARM_AUDIT_BASE_URL",
  "ARM_AUDIT_API_TOKEN"
]
```

For Claude Code, extend the server `env` object:

```json
{
  "ARM_AUDIT_BASE_URL": "${ARM_AUDIT_BASE_URL}",
  "ARM_AUDIT_API_TOKEN": "${ARM_AUDIT_API_TOKEN}"
}
```

## Fast diagnosis

| Symptom | Check |
| --- | --- |
| Server fails to start | `node --version` is 22+, and `dist/index.js` exists |
| Connected, ARM call fails | `ARM_BASE_URL` and `ARM_API_TOKEN` exist in the client process environment |
| HTTPS validation fails | Tenant URL uses HTTPS and contains no API path |
| Tool times out | Raise client tool timeout above the server request timeout |
| Claude project server is pending | Launch `claude` interactively and approve the workspace/server |
| Audit tools fail while ARM tools work | Configure the separate `ARM_AUDIT_*` variables |

## Sources

- [ARM MCP requirements and configuration](../../README.md#requirements)
- [OpenAI Codex MCP configuration](https://developers.openai.com/codex/mcp)
- [Claude Code MCP configuration](https://docs.anthropic.com/en/docs/claude-code/mcp)
