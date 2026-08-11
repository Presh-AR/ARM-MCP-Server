# Quick Start: Daily Deployment Digest

Outcome: a reviewable Markdown and CSV deployment report for one date range and destination org.

Time: 10-15 minutes.

## What this recipe uses

- `arm_list_deployments`
- `arm_get_deployment`
- `arm_get_deployment_components`
- `arm_get_deployment_stories`
- `arm_get_deployment_promotion_log`
- `arm_get_deployment_test_coverage`

ARM already supplies deployment, component, Jira-linked commit, log, and coverage evidence. Live PR metadata, Jira ownership, Excel formatting, and Confluence publication require additional tools only when ARM does not return those fields.

## Inputs

Replace:

- `<FROM_DATE>` and `<TO_DATE>` - `YYYY-MM-DD`
- `<DESTINATION_ORG>` - exact destination Salesforce org, or `all`
- `<LIMIT>` - 1-100
- `<OUTPUT_DIR>` - such as `reports/arm/2026-08-11`

## Paste this prompt

```text
Create a read-only daily ARM deployment digest.

Inputs:
- from_date: <FROM_DATE>
- to_date: <TO_DATE>
- destination_org: <DESTINATION_ORG>
- limit: <LIMIT>
- output_dir: <OUTPUT_DIR>

Rules:
- Use only read-only ARM MCP tools and local file creation.
- Do not publish, upload, comment, trigger, deploy, roll back, abort, or update a baseline.
- Preserve every exact deployment label, status, org, iteration, story ID, commit ID, user, and timestamp returned by ARM.
- Mark unavailable fields as `unavailable`; do not infer them.

Steps:
1. Call `arm_list_deployments` with fromDate, toDate, limit, and destSfOrg when destination_org is not `all`.
2. If the authenticated call succeeds with zero deployments, report zero. If the call fails, report unavailable and stop.
3. For each returned deployment label:
   a. Call `arm_get_deployment`.
   b. Resolve `latestIterationNumber` from detail.
   c. Call `arm_get_deployment_components`.
   d. Call `arm_get_deployment_stories` for that latest iteration when supported by the returned data.
   e. Call `arm_get_deployment_promotion_log` for the latest iteration.
   f. Call `arm_get_deployment_test_coverage` for the latest iteration.
4. Reconcile each result by exact deployment label and iteration. Do not combine data across labels or iterations.
5. Create output_dir if needed.
6. Write `deployment-digest.md` with:
   - executive summary
   - counts by exact ARM status
   - counts by destination org
   - one deployment evidence table
   - failed or non-terminal deployments
   - coverage failures or unavailable coverage
   - notable promotion-log diagnostics
   - missing evidence
7. Write `deployment-components.csv` using Python's standard `csv` module. Use one row per returned component with these columns:
   deployment_label, iteration, deployment_status, source_environment,
   destination_environment, component_type, component_name, file_path,
   change_type, jira_story, commit_id, triggering_user, coverage_status,
   evidence_tools
8. In every summary row, list the ARM MCP tools that supplied the evidence.
9. Return the two file paths, the deployment count, and any incomplete records.
```

## What good looks like

- Every record maps to one exact label and iteration.
- Status counts use ARM's returned values without normalization that hides differences.
- The report distinguishes zero deployments from failed access.
- The output can be regenerated for the same date range.

## Expand the workflow

Add integrations one evidence gap at a time:

| Need | Add | Result |
| --- | --- | --- |
| Live PR number, author, head SHA | GitHub MCP/API | PR traceability |
| Jira assignee and requester | Jira MCP/API | Ownership enrichment |
| Monthly workbook, one tab per day | Python with `openpyxl` | Excel artifact |
| Scheduled publication | Confluence MCP/API plus scheduler | 8 AM/7 PM delivery |

Before publishing, compare record counts and a sample of exact labels/components between the generated artifact and ARM tool responses.

## Source

- [ARM deployment reporting tools](../../README.md#deployment-reporting-v1)
