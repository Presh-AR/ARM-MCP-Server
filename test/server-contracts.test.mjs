import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const ZIP_BYTES = Buffer.from("PK\u0003\u0004contract-test");

function childEnvironment(overrides) {
  return {
    ...Object.fromEntries(
      Object.entries(process.env).filter((entry) => typeof entry[1] === "string"),
    ),
    ...overrides,
  };
}

async function readJsonBody(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  if (chunks.length === 0) return undefined;
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

async function startHarness({ genericTool = true, retries = 1 } = {}) {
  const requests = [];
  const attemptCounts = new Map();
  const downloadDir = await mkdtemp(join(tmpdir(), "arm-mcp-contract-"));
  const mockArm = http.createServer(async (request, response) => {
    const body = await readJsonBody(request);
    requests.push({
      method: request.method,
      path: request.url,
      token: request.headers.token,
      authorization: request.headers.authorization,
      correlationId: request.headers["x-correlation-id"],
      body,
    });

    const count = (attemptCounts.get(request.url) ?? 0) + 1;
    attemptCounts.set(request.url, count);

    if (request.url === "/api/retry" && count === 1) {
      response.writeHead(503, { "Content-Type": "application/json", "Retry-After": "0" });
      response.end(JSON.stringify({ ok: false, retry: true }));
      return;
    }

    if (request.url === "/api/fail" || request.url === "/api/mutation-fail") {
      response.writeHead(503, { "Content-Type": "application/json", "Retry-After": "0" });
      response.end(JSON.stringify({ ok: false }));
      return;
    }

    if (
      request.url?.startsWith("/logs/audit_logs/download") &&
      request.url.includes("2026-06-01")
    ) {
      response.writeHead(200, { "Content-Type": "application/zip" });
      response.end(Buffer.alloc(2048));
      return;
    }

    if (request.url?.startsWith("/logs/audit_logs/download")) {
      response.writeHead(200, {
        "Content-Type": "application/zip",
        "Content-Length": String(ZIP_BYTES.byteLength),
      });
      response.end(ZIP_BYTES);
      return;
    }

    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ ok: true, requestPath: request.url }));
  });

  await new Promise((resolve, reject) => {
    mockArm.once("error", reject);
    mockArm.listen(0, "127.0.0.1", resolve);
  });

  const address = mockArm.address();
  assert(address && typeof address === "object");
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["dist/index.js"],
    env: childEnvironment({
      ARM_BASE_URL: baseUrl,
      ARM_API_TOKEN: "arm-test-token",
      ARM_MAX_RETRIES: String(retries),
      ARM_ENABLE_GENERIC_TOOL: String(genericTool),
      ARM_AUDIT_BASE_URL: baseUrl,
      ARM_AUDIT_API_TOKEN: "audit-test-token",
      ARM_AUDIT_MAX_RETRIES: String(retries),
      ARM_AUDIT_DOWNLOAD_DIR: downloadDir,
      ARM_AUDIT_MAX_DOWNLOAD_BYTES: "1024",
    }),
  });
  const client = new Client({ name: "arm-contract-test", version: "1.0.0" });
  await client.connect(transport);

  return {
    client,
    requests,
    attemptCounts,
    downloadDir,
    async close() {
      await client.close().catch(() => undefined);
      await new Promise((resolve) => mockArm.close(resolve));
      await rm(downloadDir, { recursive: true, force: true });
    },
  };
}

test("all dedicated tools expose and execute the published API contracts", async () => {
  const harness = await startHarness();
  const { client, requests, downloadDir } = harness;

  try {
    const tools = await client.listTools();
    assert.equal(tools.tools.length, 28);
    assert(tools.tools.every((tool) => tool.annotations));
    assert(tools.tools.every((tool) => tool.outputSchema?.type === "object"));

    const toolNames = tools.tools.map((tool) => tool.name);
    for (const expected of [
      "arm_ncino_trigger_build",
      "arm_get_deployment_test_coverage",
      "arm_audit_download_logs",
      "arm_call_api",
    ]) {
      assert(toolNames.includes(expected));
    }
    assert.equal(
      tools.tools.find((tool) => tool.name === "arm_ncino_trigger_build")?.annotations
        ?.readOnlyHint,
      false,
    );

    const resources = await client.listResources();
    assert.deepEqual(
      resources.resources.map((resource) => resource.uri).sort(),
      [
        "arm://docs/audit-logs",
        "arm://docs/auth",
        "arm://docs/cijobs-v1",
        "arm://docs/deployments-v1",
        "arm://docs/ncino-cijobs-v1",
        "arm://docs/overview",
      ],
    );
    const deploymentResource = await client.readResource({ uri: "arm://docs/deployments-v1" });
    assert.match(deploymentResource.contents[0].text, /\/api\/deployments\/v1\/list/);
    assert.doesNotMatch(deploymentResource.contents[0].text, /\/rabit\/api/);

    const prompts = await client.listPrompts();
    assert.equal(prompts.prompts.length, 8);
    const ncinoPrompt = await client.getPrompt({
      name: "arm_ncino_build_and_monitor_guide",
      arguments: {
        job_name: "Feature Migration",
        title: "Release 26.3",
        deploy: "true",
        commit_feature: "false",
      },
    });
    assert.match(ncinoPrompt.messages[0].content.text, /arm_ncino_poll_build_status/);

    const calls = [
      ["arm_list_ci_jobs", { headers: { "X-Correlation-ID": "contract" } }],
      ["arm_ci_job_history", { ciJobName: "CI Job", from: 0, to: 10 }],
      ["arm_latest_results", { ciJobName: "CI Job" }],
      ["arm_poll_job_status", { ciJobName: "CI Job", buildNumber: 7 }],
      ["arm_rollback_history", { ciJobName: "CI Job", buildNumber: 7 }],
      ["arm_rollback_details", { ciJobName: "CI Job" }],
      ["arm_trigger_build", { projectName: "Project", title: "Release" }],
      [
        "arm_update_baseline_revision",
        { projectName: "Project", baseLineRevision: "abc123" },
      ],
      [
        "arm_quick_deploy",
        { ciJobName: "CI Job", buildNumber: 7, projectName: "Project", title: "Release" },
      ],
      ["arm_start_rollback", { projectName: "Project", title: "Release" }],
      [
        "arm_abort_ci_job",
        { ciJobName: "CI Job", buildNumber: 7, projectName: "Project", title: "Release" },
      ],
      ["arm_ncino_list_ci_jobs", {}],
      ["arm_ncino_list_job_history", {}],
      [
        "arm_ncino_trigger_build",
        {
          jobName: "Feature Migration",
          title: "Release 26.3",
          deploy: true,
          commitFeature: false,
          note: "Contract test",
          rollbackEnabled: true,
          deployedSFOrg: "Production",
          projectType: "SalesForceFeature",
        },
      ],
      ["arm_ncino_get_build_summary", { jobName: "Feature Migration", nextPage: false }],
      ["arm_ncino_get_latest_build", { jobName: "Feature Migration" }],
      ["arm_ncino_get_build_history", { jobName: "Feature Migration", buildNumber: 42 }],
      ["arm_ncino_poll_build_status", { jobName: "Feature Migration", buildNumber: 42 }],
      [
        "arm_list_deployments",
        {
          status: "Successful",
          fromDate: "2026-07-01",
          toDate: "2026-07-31",
          labelName: "Release",
          destSfOrg: "Production",
          limit: 25,
        },
      ],
      ["arm_get_deployment", { label: "Release 26.3" }],
      ["arm_get_deployment_components", { label: "Release 26.3" }],
      ["arm_get_deployment_stories", { label: "Release 26.3", iterationNumber: 2 }],
      ["arm_get_deployment_promotion_log", { label: "Release 26.3", iterationNumber: 2 }],
      ["arm_get_deployment_test_coverage", { label: "Release 26.3", iterationNumber: 2 }],
      [
        "arm_audit_get_logs",
        {
          startTime: "2026-07-01T00:00:00Z",
          maxResults: 500,
          eventType: "LOGIN,DEPLOYMENT",
        },
      ],
    ];

    for (const [name, args] of calls) {
      const result = await client.callTool({ name, arguments: args });
      assert.equal(result.isError, undefined, name);
      assert.equal(result.structuredContent.status, 200, name);
    }

    const eventTypes = await client.callTool({
      name: "arm_audit_list_event_types",
      arguments: {},
    });
    assert.equal(eventTypes.structuredContent.data.length, 12);

    const download = await client.callTool({
      name: "arm_audit_download_logs",
      arguments: {
        startTime: "2026-07-01T00:00:00Z",
        endTime: "2026-07-31T00:00:00Z",
      },
    });
    const resourceLink = download.content.find((content) => content.type === "resource_link");
    assert(resourceLink);
    const downloadedPath = fileURLToPath(resourceLink.uri);
    assert.equal(join(downloadDir, resourceLink.name), downloadedPath);
    assert.deepEqual(await readFile(downloadedPath), ZIP_BYTES);
    assert.equal((await stat(downloadedPath)).mode & 0o777, 0o600);

    assert.equal(requests.length, 26);
    assert.deepEqual(
      requests.map(({ method, path }) => ({ method, path })),
      [
        { method: "GET", path: "/api/cijobs/v1/listcijobs" },
        { method: "GET", path: "/api/cijobs/v1/history/CI%20Job?from=0&to=10" },
        { method: "GET", path: "/api/cijobs/v1/latestresults/CI%20Job" },
        { method: "GET", path: "/api/cijobs/v1/pollstatus/CI%20Job/7" },
        { method: "GET", path: "/api/cijobs/v1/rollback/history/CI%20Job/7" },
        { method: "GET", path: "/api/cijobs/v1/rollback/CI%20Job" },
        { method: "POST", path: "/api/cijobs/v1/trigger" },
        { method: "POST", path: "/api/cijobs/v1/update/baselinerevision" },
        { method: "POST", path: "/api/cijobs/v1/triggerquickdeploy/CI%20Job/7" },
        { method: "POST", path: "/api/cijobs/v1/rollback" },
        { method: "PUT", path: "/api/cijobs/v1/abort/CI%20Job/7" },
        { method: "GET", path: "/api/cijobs/v1/ncino/getalljobs" },
        { method: "GET", path: "/api/cijobs/v1/ncino/gethistory" },
        { method: "POST", path: "/api/cijobs/v1/ncino/trigger" },
        { method: "POST", path: "/api/cijobs/v1/ncino/getcijobsummary" },
        { method: "POST", path: "/api/cijobs/v1/ncino/getcijobinfo" },
        { method: "POST", path: "/api/cijobs/v1/ncino/getcijobbuildhistory" },
        { method: "POST", path: "/api/cijobs/v1/ncino/pollstatus" },
        {
          method: "GET",
          path:
            "/api/deployments/v1/list?status=Successful&fromDate=2026-07-01&toDate=2026-07-31&labelName=Release&destSfOrg=Production&limit=25",
        },
        { method: "GET", path: "/api/deployments/v1/Release%2026.3" },
        { method: "GET", path: "/api/deployments/v1/Release%2026.3/components" },
        {
          method: "GET",
          path: "/api/deployments/v1/Release%2026.3/stories?iterationNumber=2",
        },
        { method: "GET", path: "/api/deployments/v1/Release%2026.3/logs/2" },
        { method: "GET", path: "/api/deployments/v1/Release%2026.3/coverage/2" },
        {
          method: "GET",
          path:
            "/logs/audit_logs?startTime=2026-07-01T00%3A00%3A00Z&maxResults=500&eventType=LOGIN%2CDEPLOYMENT",
        },
        {
          method: "GET",
          path:
            "/logs/audit_logs/download?startTime=2026-07-01T00%3A00%3A00Z&endTime=2026-07-31T00%3A00%3A00Z",
        },
      ],
    );

    assert.equal(requests[0].correlationId, "contract");
    assert(requests.slice(0, 24).every((request) => request.token === "arm-test-token"));
    assert(
      requests
        .slice(24)
        .every((request) => request.authorization === "Bearer audit-test-token"),
    );
    assert(requests.filter((request) => request.method === "GET").every((request) => !request.body));
    assert.deepEqual(requests[6].body, { projectName: "Project", title: "Release" });
    assert.deepEqual(requests[13].body, {
      jobName: "Feature Migration",
      jobHistory: {
        title: "Release 26.3",
        deploy: true,
        commitFeature: false,
        note: "Contract test",
        rollbackEnabled: true,
        deployedSFOrg: "Production",
        projectType: "SalesForceFeature",
      },
    });
  } finally {
    await harness.close();
  }
});

test("retry, validation, and generic-tool controls fail safely", async () => {
  const harness = await startHarness();
  const { client, requests, attemptCounts } = harness;

  try {
    const retried = await client.callTool({
      name: "arm_call_api",
      arguments: { path: "/api/retry", method: "GET" },
    });
    assert.equal(retried.isError, undefined);
    assert.equal(attemptCounts.get("/api/retry"), 2);

    const failedRead = await client.callTool({
      name: "arm_call_api",
      arguments: { path: "/api/fail", method: "GET" },
    });
    assert.equal(failedRead.isError, true);
    assert.equal(attemptCounts.get("/api/fail"), 2);

    const failedMutation = await client.callTool({
      name: "arm_call_api",
      arguments: { path: "/api/mutation-fail", method: "POST", body: { execute: true } },
    });
    assert.equal(failedMutation.isError, true);
    assert.equal(attemptCounts.get("/api/mutation-fail"), 1);

    await assert.rejects(
      client.callTool({
        name: "arm_audit_download_logs",
        arguments: { startTime: "2026-06-01T00:00:00Z" },
      }),
      /exceeds ARM_AUDIT_MAX_DOWNLOAD_BYTES/,
    );

    const requestCount = requests.length;
    await assert.rejects(
      client.callTool({
        name: "arm_call_api",
        arguments: { path: "https://example.com/collect-token", method: "GET" },
      }),
      /path must start with \/api\//,
    );
    await assert.rejects(
      client.callTool({
        name: "arm_call_api",
        arguments: { path: "/api/%2e%2e/admin", method: "GET" },
      }),
      /path must start with \/api\//,
    );
    await assert.rejects(
      client.callTool({
        name: "arm_list_ci_jobs",
        arguments: { headers: { token: "replacement" } },
      }),
      /cannot override protected headers/,
    );
    await assert.rejects(
      client.callTool({
        name: "arm_call_api",
        arguments: { path: "/api/get-with-body", method: "GET", body: { invalid: true } },
      }),
      /GET requests cannot include a request body/,
    );
    await assert.rejects(
      client.callTool({
        name: "arm_audit_download_logs",
        arguments: {
          startTime: "2026-01-01T00:00:00Z",
          endTime: "2026-05-01T00:00:00Z",
        },
      }),
      /within 90 days/,
    );
    await assert.rejects(
      client.callTool({
        name: "arm_list_deployments",
        arguments: { fromDate: "2026-08-01", toDate: "2026-07-01" },
      }),
      /toDate must not be before fromDate/,
    );
    await assert.rejects(
      client.callTool({
        name: "arm_list_deployments",
        arguments: { fromDate: "2026-02-31" },
      }),
      /fromDate must use YYYY-MM-DD format/,
    );
    await assert.rejects(
      client.callTool({
        name: "arm_ncino_get_build_history",
        arguments: { jobName: "Feature Migration", buildNumber: 0 },
      }),
      /buildNumber must be a positive integer/,
    );
    assert.equal(requests.length, requestCount);
  } finally {
    await harness.close();
  }
});

test("generic API access is hidden and blocked by default", async () => {
  const harness = await startHarness({ genericTool: false, retries: 0 });
  const { client, requests } = harness;

  try {
    const tools = await client.listTools();
    assert.equal(tools.tools.length, 27);
    assert(!tools.tools.some((tool) => tool.name === "arm_call_api"));
    await assert.rejects(
      client.callTool({
        name: "arm_call_api",
        arguments: { path: "/api/cijobs/v1/listcijobs", method: "GET" },
      }),
      /arm_call_api is disabled/,
    );
    assert.equal(requests.length, 0);
  } finally {
    await harness.close();
  }
});
