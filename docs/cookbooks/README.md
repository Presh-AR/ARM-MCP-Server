# ARM MCP Quick Start Cookbooks

Use AutoRABIT ARM from Codex or Claude Code to answer a release question in minutes, then expand the workflow only when the first result is useful.

These cookbooks are based on two NVIDIA patterns in the July 2026 QBR:

- PR component audit plus ARM CI validation (slides 12-14)
- Twice-daily deployment reporting with ARM and adjacent systems (slides 15-16)

The appendix shows the larger progression: standardized pipelines, governance, MCP/Open APIs, then agentic pipelines (slides 30-31). The recipes follow that progression. Each starts with a bounded human question and verified ARM data.

## Start here

1. [Connect Codex or Claude Code](00-connect-codex-and-claude.md)
2. Pick one outcome:
   - [PR component and CI readiness review](01-pr-component-and-ci-readiness.md)
   - [Daily deployment digest](02-daily-deployment-digest.md)
   - [Failed CI build triage](03-failed-ci-build-triage.md)
   - [nCino build health report](04-ncino-build-health.md)
   - [Audit activity review](05-audit-activity-review.md)
   - [Controlled build or quick deploy](06-controlled-build-and-quick-deploy.md)

## First-principles map

### 🍁 Fundamentals of the ask

An AI client needs three things to create value from ARM:

1. A trusted ARM endpoint and token.
2. A narrow operational question.
3. A tool result that can prove the answer.

MCP supplies the tool contract. Codex or Claude Code supplies planning, synthesis, and artifact creation. ARM remains the system of record for ARM status.

### 🧐 System 2 problem

The hard part is evidence alignment. A Git diff, CI build, deployment iteration, Jira story, and audit event can describe different slices of the same release. A polished summary can still be wrong when those identifiers do not line up.

Every cookbook therefore makes identifiers explicit, keeps independent status fields separate, and labels unavailable evidence as unavailable.

### 2️⃣ System 2 solution

Use a repeatable loop:

1. Resolve an exact job, deployment label, build number, iteration, or date range.
2. Read ARM data through dedicated MCP tools.
3. Reconcile status and traceability across returned records.
4. Produce a reviewable artifact with evidence and gaps.
5. Request explicit approval before any mutation.

### 1️⃣ System 1 solution

Connect the server, paste one cookbook prompt, replace the angle-bracket placeholders, and run it.

### 👾 Sherlock thinking

Treat missing data, disagreeing statuses, stale build numbers, and unmatched components as findings. Empty evidence never proves success.

### 🍀 Bitter lesson

General reasoning becomes useful when the model can repeatedly call narrow, reliable tools. Add another integration only when it closes a named evidence gap.

### 🪼 Inversion thinking

Ask: “What would make this release decision wrong?” Then require that evidence in the output contract.

## Verified server surface

The current server exposes 27 dedicated tools:

- 11 standard CI job tools
- 7 nCino CI job tools
- 6 deployment reporting tools
- 3 SIEM audit tools

It also exposes six reference resources and eight guided prompts at the MCP protocol layer. Client presentation varies. The natural-language prompts in these cookbooks work in both Codex and Claude Code.

The optional generic `arm_call_api` tool is disabled by default. None of these quick starts require it.

## Value ladder

| Level | Outcome | ARM MCP alone | Extra integration |
| --- | --- | --- | --- |
| 1 | Answer one release question | Yes | None |
| 2 | Produce a repeatable report | Yes | None |
| 3 | Enrich with live PR, Jira, or Confluence data | Partial | GitHub, Jira, or Confluence MCP/API |
| 4 | Post comments or publish reports | No | Write-enabled destination integration |
| 5 | Trigger a build or deployment | Yes | Explicit operator approval |

## Evidence rules

- Preserve exact case-sensitive job names, labels, build numbers, and iteration numbers.
- Keep build, deployment, post-deployment, quick-deploy, rollback, and coverage statuses separate.
- Use `UNKNOWN` when required data is missing or inaccessible.
- Cite the MCP tool used for every decision row.
- Do not call `arm_trigger_build`, `arm_quick_deploy`, `arm_start_rollback`, `arm_abort_ci_job`, `arm_update_baseline_revision`, or `arm_ncino_trigger_build` unless the prompt explicitly authorizes the mutation.
- Treat a tool transport or authentication failure as an access problem, never as an empty result.

## PP

PP: Start with the deployment digest. It proves connectivity, exercises several read-only tools, and gives leaders something useful before the automation committee invents a twelve-box architecture diagram.

Meme: “We connected MCP.” “Great. Which decision got faster?”

## Sources

- AutoRABIT NVIDIA QBR, July 2026, slides 12-16 and 30-31 (user-provided source deck)
- [ARM MCP server contract and tool catalog](../../README.md)
- [OpenAI: Connect Codex to MCP](https://developers.openai.com/codex/mcp)
- [Anthropic: Connect Claude Code to MCP](https://docs.anthropic.com/en/docs/claude-code/mcp)
