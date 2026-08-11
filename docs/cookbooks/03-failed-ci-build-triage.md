# Quick Start: Failed CI Build Triage

Outcome: an evidence-backed failure summary and next action without changing ARM state.

Time: 5 minutes.

## What this recipe uses

- `arm_list_ci_jobs`
- `arm_latest_results`
- `arm_poll_job_status`
- `arm_ci_job_history`
- `arm_rollback_history`
- `arm_rollback_details`

## Inputs

Replace `<CI_JOB_NAME>` and `<BUILD_NUMBER_OR_LATEST>`.

## Paste this prompt

```text
Investigate a failed or stalled ARM CI build. Keep the workflow read-only.

Inputs:
- ci_job_name: <CI_JOB_NAME>
- build_number: <BUILD_NUMBER_OR_LATEST>

Rules:
- Do not call trigger, quick deploy, rollback, abort, or baseline-update tools.
- Require an exact, case-sensitive CI job match.
- Keep build status, quick-deploy status, rollback validation, tests, coverage, scans, and deployment status separate.
- Label interpretation as `proven`, `likely`, or `unknown`.

Steps:
1. Call `arm_list_ci_jobs` and verify one exact match for ci_job_name.
2. Call `arm_latest_results` for the job.
3. Resolve the selected build number. If the user supplied a number, do not silently replace it with latest.
4. Call `arm_poll_job_status` for the selected build.
5. Call `arm_ci_job_history` and use the smallest range that includes recent comparable builds.
6. If ARM returns rollback-related evidence, call `arm_rollback_history` and `arm_rollback_details`. These are read-only checks.
7. Compare the selected build with recent successful and failed builds only when exact comparable fields are available.

Output:
1. One-line status: FAILED, STALLED, IN PROGRESS, SUCCESSFUL, or UNKNOWN
2. Exact identity: job and build number
3. Timeline: returned stages and timestamps in order
4. Failure evidence: exact returned messages, failed stages, tests, components, or validations
5. Regression clues: differences from recent comparable builds
6. Rollback evidence: eligibility/validation/history as separate fields
7. Root-cause assessment:
   - proven: directly returned by ARM
   - likely: supported by at least two observations
   - unknown: missing evidence
8. Next action: one smallest reversible diagnostic step
9. Operator options: draft-only commands or ARM actions; do not execute them

For every factual row, include the source MCP tool.
```

## Follow-up prompt for one failure

```text
Take the highest-confidence failure from the previous report.

Trace it to the narrowest returned stage, component, test, log message, or status transition. Quote only the minimum exact error fragment needed. Separate ARM evidence from your inference. Recommend one diagnostic that can falsify the leading hypothesis. Do not mutate ARM state.
```

## Source

- [ARM CI Jobs v1 tools](../../README.md#ci-jobs-v1)
