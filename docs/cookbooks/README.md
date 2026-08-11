# ARM MCP Quick Start Cookbooks

Use AutoRABIT ARM from Codex or Claude Code to answer a release question in minutes, then expand the workflow only when the first result is useful.

## Start here

1. [Connect Codex or Claude Code](00-connect-codex-and-claude.md)
2. Pick one outcome:
   - [PR component and CI readiness review](01-pr-component-and-ci-readiness.md)
   - [Daily deployment digest](02-daily-deployment-digest.md)
   - [Failed CI build triage](03-failed-ci-build-triage.md)
   - [nCino build health report](04-ncino-build-health.md)
   - [Audit activity review](05-audit-activity-review.md)
   - [Controlled build or quick deploy](06-controlled-build-and-quick-deploy.md)

An AI client needs three things to create value from ARM:

1. A trusted ARM endpoint and token.
2. A narrow operational question.
3. A tool result that can prove the answer.

MCP supplies the tool contract. Codex or Claude Code supplies planning, synthesis, and artifact creation. ARM remains the system of record for ARM status.

The hard part is evidence alignment. A Git diff, CI build, deployment iteration, Jira story, and audit event can describe different slices of the same release. A polished summary can still be wrong when those identifiers do not line up.

Every cookbook therefore makes identifiers explicit, keeps independent status fields separate, and labels unavailable evidence as unavailable.

Use a repeatable loop:

1. Resolve an exact job, deployment label, build number, iteration, or date range.
2. Read ARM data through dedicated MCP tools.
3. Reconcile status and traceability across returned records.
4. Produce a reviewable artifact with evidence and gaps.
5. Request explicit approval before any mutation.

Connect the server, paste one cookbook prompt, replace the angle-bracket placeholders, and run it.

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
