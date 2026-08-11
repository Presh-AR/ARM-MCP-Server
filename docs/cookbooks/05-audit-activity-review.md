# Quick Start: Audit Activity Review

Outcome: a bounded, read-only summary of ARM audit activity from CEF-formatted SIEM logs.

Time: 5-10 minutes.

Prerequisite: configure the separate `ARM_AUDIT_BASE_URL` and `ARM_AUDIT_API_TOKEN` values in [client setup](00-connect-codex-and-claude.md#4-optional-audit-configuration).

## What this recipe uses

- `arm_audit_list_event_types`
- `arm_audit_get_logs`
- Optional `arm_audit_download_logs` for a bounded ZIP export

## Inputs

Replace:

- `<START_TIME_ISO>` - such as `2026-08-11T00:00:00Z`
- `<EVENT_TYPES>` - comma-separated values such as `LOGIN,DEPLOYMENT,CIBUILD`, or `all`
- `<MAX_RESULTS>` - positive integer

## Paste this prompt

```text
Review AutoRABIT ARM audit activity. Keep the workflow read-only.

Inputs:
- start_time: <START_TIME_ISO>
- event_types: <EVENT_TYPES>
- max_results: <MAX_RESULTS>

Rules:
- Use the separate ARM audit MCP tools.
- Do not treat an authentication, transport, timeout, or parse failure as zero events.
- Preserve exact timestamps, event types, severities, users, and object identifiers.
- Keep observed facts separate from anomaly hypotheses.

Steps:
1. Call `arm_audit_list_event_types`.
2. Validate each requested event type against the returned list. If event_types is `all`, omit the filter.
3. Call `arm_audit_get_logs` with startTime, maxResults, and the validated comma-separated eventType filter.
4. Parse each CEF entry into timestamp, vendor, product, productVersion, eventType, name, severity, and extensions.
5. Count only successfully parsed entries. Report unparsed entries separately.

Output:
1. Query result: succeeded, failed, or partial
2. Scope: exact start time, filters, max results, returned count, parsed count
3. Counts by exact event type and severity
4. Activity timeline in chronological order
5. Identity summary: users or actors exactly as returned
6. Notable sequences: failed logins, CI builds, deployments, commits, or merges when observed
7. Anomaly hypotheses: evidence, competing explanation, and confidence
8. Data-quality gaps and truncation risk
9. Two narrower follow-up queries

Include `arm_audit_get_logs` as the evidence source for observed events.
```

## Optional evidence export

The server limits audit ZIP ranges to 90 days and writes the file to `ARM_AUDIT_DOWNLOAD_DIR` or the operating-system temp directory.

```text
Download an ARM audit evidence ZIP for this exact bounded range:
- start_time: <START_TIME_ISO>
- end_time: <END_TIME_ISO>

Call `arm_audit_download_logs` once. Return the resource-link path, byte size when provided, and requested range. Do not open, move, upload, or delete the ZIP.
```

## Source

- [ARM SIEM audit tools](../../README.md#siem-audit-logs)
