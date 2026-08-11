# Quick Start: PR Component and CI Readiness

Outcome: a read-only `READY`, `NOT READY`, or `UNKNOWN` recommendation backed by the local change set and ARM CI evidence.

Time: 5-10 minutes.

Inspired by: NVIDIA's two-step workflow on slides 12-14 - component audit, then CI and validation review.

## What this recipe uses

- Local Git or a connected GitHub tool for the PR change set
- `arm_list_ci_jobs`
- `arm_latest_results`
- `arm_poll_job_status` when the build is still running
- Optional deployment tools when a deployment label and iteration are available

The ARM MCP server does not expose GitHub comment tools or dedicated CodeScan tools. Connect those systems separately if you want automated comment posting or CodeScan-specific evidence.

## Inputs

Replace:

- `<BASE_REF>` - target branch or commit, such as `origin/main`
- `<HEAD_REF>` - PR branch or commit, such as `HEAD`
- `<CI_JOB_NAME>` - exact, case-sensitive ARM CI job name
- `<BUILD_NUMBER_OR_LATEST>` - a positive build number or `latest`
- `<MIN_COVERAGE>` - your gate, such as `75`
- `<DEPLOYMENT_LABEL_OR_NONE>` - exact ARM deployment label or `none`
- `<ITERATION_OR_LATEST>` - positive iteration or `latest`

## Paste this prompt

```text
Run a read-only PR component and ARM CI readiness review.

Inputs:
- base_ref: <BASE_REF>
- head_ref: <HEAD_REF>
- ci_job_name: <CI_JOB_NAME>
- build_number: <BUILD_NUMBER_OR_LATEST>
- minimum_coverage_percent: <MIN_COVERAGE>
- deployment_label: <DEPLOYMENT_LABEL_OR_NONE>
- deployment_iteration: <ITERATION_OR_LATEST>

Rules:
- Do not call any mutation tool.
- Preserve exact names, paths, build numbers, labels, and statuses.
- Mark missing or inaccessible evidence as UNKNOWN.
- Never infer success from an empty response.

Step 1 - component audit:
1. Compare base_ref with head_ref using the available local Git or GitHub read tools.
2. List every added, modified, renamed, and deleted path.
3. For Salesforce metadata paths, derive component type and component name only when the path proves them. Label everything else `unclassified`.
4. Detect duplicate, generated, unrelated, or unexpected files and explain the exact rule used.
5. Return `CLEAR`, `MISMATCH`, or `UNKNOWN` for the component audit.

Step 2 - ARM CI and validation:
1. Call `arm_list_ci_jobs` and require one exact, case-sensitive match for ci_job_name.
2. Call `arm_latest_results` for ci_job_name.
3. If a specific build number was supplied or the latest build is not terminal, call `arm_poll_job_status` with the selected build number.
4. Extract each ARM status field separately. Extract test, coverage, and scan evidence only when the response contains it.
5. If deployment_label is not `none`, call `arm_get_deployment`, resolve the requested or latest iteration, then call `arm_get_deployment_components` and `arm_get_deployment_test_coverage`.
6. Compare ARM deployment components with the PR component inventory when both are available. Report exact extras and omissions.

Decision:
- READY: component audit is CLEAR, selected ARM build is terminal and successful, every required validation returned success, and numeric coverage is at least minimum_coverage_percent.
- NOT READY: any proven mismatch, failed ARM status, failed validation, or numeric coverage below the threshold.
- UNKNOWN: any required evidence is missing, inaccessible, stale, ambiguous, or refers to a different build or iteration.

Output exactly these sections:
1. Verdict - one line with READY, NOT READY, or UNKNOWN
2. Identity - base/head refs, CI job, build number, deployment label, iteration
3. Component audit - counts by action and component type, then exact mismatches
4. ARM checks - one row per returned status or validation field with value and source tool
5. Coverage - observed value, threshold, and source; use unavailable when absent
6. Blocking findings - evidence-backed only
7. Missing evidence
8. Suggested PR comment - concise, factual, and comment-only; do not post it
```

## Expected decision boundary

The AI recommendation remains advisory. ARM's returned status supplies the ARM gate evidence. A separate GitHub integration and explicit authorization are required to post the comment or change merge state.

## Fast expansion

After the read-only result is reliable:

1. Connect a GitHub MCP server.
2. Add CodeScan results through a verified API or MCP contract.
3. Post the generated comment only after the evidence identifiers match the PR head SHA and selected ARM build.
4. Keep the merge action outside the agent until the team defines an explicit authorization policy.

## Source

- AutoRABIT NVIDIA QBR, July 2026, slides 12-14
- [ARM CI and deployment tool catalog](../../README.md#tools)
