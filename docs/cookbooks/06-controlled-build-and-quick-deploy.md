# Quick Start: Controlled Build or Quick Deploy

Outcome: prepare, approve, execute, and verify one ARM mutation with exact identifiers.

Time: 5-15 minutes, depending on build duration.

This cookbook has two phases. Phase A reads and prepares. Phase B runs only after an operator provides the exact approval phrase.

## Option 1: Trigger and monitor a CI build

Replace `<CI_JOB_NAME>`, `<PROJECT_NAME>`, and `<BUILD_TITLE>`.

### Phase A - prepare

```text
Prepare an ARM CI build. Do not trigger it yet.

Inputs:
- ci_job_name: <CI_JOB_NAME>
- project_name: <PROJECT_NAME>
- title: <BUILD_TITLE>

1. Call `arm_list_ci_jobs` and require one exact, case-sensitive match for ci_job_name.
2. Call `arm_latest_results` and `arm_poll_job_status` for the latest build.
3. Report any current in-progress build or ambiguous project/job mapping.
4. Show the exact proposed MCP call:
   tool: arm_trigger_build
   arguments: projectName and title
5. State that mutation tools do not retry automatically.
6. Stop. Do not call `arm_trigger_build`.

The only authorization phrase for Phase B is:
APPROVE ARM BUILD: <PROJECT_NAME> | <BUILD_TITLE>
```

### Phase B - execute after exact approval

```text
The operator supplied the exact authorization phrase from Phase A.

1. Verify that projectName and title exactly match the approved values.
2. Call `arm_trigger_build` once.
3. Capture the returned build number (`cyclenum`) when present.
4. Call `arm_poll_job_status` for the exact ciJobName and returned build number.
5. Poll at most six total times. If still non-terminal, stop and report IN PROGRESS.
6. Report trigger response, build number, current status, quick-deploy status, rollback validation flag, and every MCP tool called.
7. Do not quick deploy, abort, roll back, or update a baseline.
```

## Option 2: Quick deploy a validated build

Replace `<CI_JOB_NAME>`, `<BUILD_NUMBER>`, `<PROJECT_NAME>`, and `<BUILD_TITLE>`.

### Phase A - validate and prepare

```text
Prepare a quick deploy. Do not deploy yet.

Inputs:
- ci_job_name: <CI_JOB_NAME>
- build_number: <BUILD_NUMBER>
- project_name: <PROJECT_NAME>
- title: <BUILD_TITLE>

1. Call `arm_list_ci_jobs` and require one exact, case-sensitive job match.
2. Call `arm_poll_job_status` for the exact build number.
3. Call `arm_latest_results` and reconcile its build identity with the requested build.
4. Report build status, quick-deploy status, rollback validation, tests, scans, and coverage exactly as returned.
5. If the requested build cannot be proven eligible from returned evidence, classify BLOCKED.
6. Show the exact proposed MCP call:
   tool: arm_quick_deploy
   arguments: ciJobName, buildNumber, projectName, title
7. Stop. Do not call `arm_quick_deploy`.

The only authorization phrase for Phase B is:
APPROVE ARM QUICK DEPLOY: <CI_JOB_NAME> | <BUILD_NUMBER> | <PROJECT_NAME> | <BUILD_TITLE>
```

### Phase B - execute after exact approval

```text
The operator supplied the exact quick-deploy authorization phrase from Phase A.

1. Verify all four identifiers exactly match the approved values.
2. Call `arm_quick_deploy` once.
3. Call `arm_poll_job_status` for the exact job and build number.
4. Report HTTP status, initiation message, current build/quick-deploy status, rollback validation flag, and every MCP tool called.
5. Do not retry the mutation automatically. Do not roll back or abort.
```

## nCino mutation

Use the same two-phase pattern with `arm_ncino_trigger_build`. The approval record must include exact `jobName`, `title`, `deploy`, `commitFeature`, and destination org. Pass `deploy` and `commitFeature` as JSON booleans.

## Source

- [ARM mutation tools and behavior](../../README.md#ci-jobs-v1)
- [ARM guided prompts](../../README.md#prompts)
