# Quick Start: nCino Build Health

Outcome: a read-only nCino build report that keeps feature, deployment, post-deployment, and rollback outcomes separate.

Time: 5-10 minutes.

## What this recipe uses

- `arm_ncino_list_ci_jobs`
- `arm_ncino_get_latest_build`
- `arm_ncino_get_build_summary`
- `arm_ncino_poll_build_status`
- `arm_ncino_get_build_history`

## Inputs

Replace `<NCINO_JOB_NAME>` and `<BUILD_NUMBER_OR_LATEST>`.

## Paste this prompt

```text
Generate a read-only nCino CI build health report.

Inputs:
- job_name: <NCINO_JOB_NAME>
- build_number: <BUILD_NUMBER_OR_LATEST>

Rules:
- Do not call `arm_ncino_trigger_build` or any other mutation tool.
- Require one exact, case-sensitive match for job_name.
- If build_number is supplied, use that build. If it is `latest`, resolve the number from ARM.
- Keep every ARM status field separate when fields disagree.
- State missing fields as unavailable. Do not infer success from an empty field.

Steps:
1. Call `arm_ncino_list_ci_jobs` and verify the exact job.
2. Call `arm_ncino_get_latest_build`; use its buildNumber only when the input is `latest`.
3. Call `arm_ncino_get_build_summary` for recent context.
4. Call `arm_ncino_poll_build_status` for the selected job and build number.
5. Call `arm_ncino_get_build_history` for feature and version-level outcomes.

Output:
1. Overall classification: HEALTHY, FAILED, IN PROGRESS, DEGRADED, or UNKNOWN
2. Identity: exact job, build number, title, destination org, trigger identity, timestamps
3. Status matrix: build, deployment, post-deployment, rollback, metadata retrieval, data retrieval, and any other returned status as separate rows
4. Failed features or versions: exact names, versions, stages, and returned messages
5. Rollback: enabled, eligible, validated, attempted, and result as separate returned fields
6. Recent context: comparable builds only; explain the comparison key
7. Missing or contradictory evidence
8. One recommended next diagnostic action

Include the source MCP tool for every evidence row.
```

## Claude Code shortcut

The server exposes `arm_ncino_build_report_guide` as an MCP prompt. In Claude Code, type `/`, select the dynamically discovered prompt for the `autorabit-arm` server, and supply the job name and optional build number. Use the full prompt above when you need the strict output contract.

## Source

- [ARM nCino CI Jobs v1 tools](../../README.md#ncino-ci-jobs-v1)
