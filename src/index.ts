#!/usr/bin/env node

import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ErrorCode,
  GetPromptRequestSchema,
  ListPromptsRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  McpError,
  ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
type JsonObject = Record<string, unknown>;

interface ArmConfig {
  baseUrl: string;
  apiToken: string;
  timeoutMs: number;
  maxRetries: number;
}

interface AuditConfig {
  baseUrl: string;
  bearerToken: string;
  timeoutMs: number;
  maxRetries: number;
  downloadDir: string;
  maxDownloadBytes: number;
}

interface HttpResult {
  status: number;
  data: unknown;
  headers: Record<string, string>;
}

const RETRYABLE_HTTP_STATUSES = new Set([429, 502, 503, 504]);
const PROTECTED_HEADERS = new Set(["authorization", "content-length", "host", "token"]);

function getBooleanEnv(name: string, fallback = false): boolean {
  const raw = process.env[name]?.trim().toLowerCase();
  if (!raw) return fallback;
  if (raw === "true" || raw === "1") return true;
  if (raw === "false" || raw === "0") return false;
  throw new McpError(ErrorCode.InvalidRequest, `${name} must be true, false, 1, or 0`);
}

function getIntegerEnv(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new McpError(
      ErrorCode.InvalidRequest,
      `${name} must be an integer from ${min} to ${max}`,
    );
  }
  return value;
}

function normalizeBaseUrl(raw: string): string {
  const trimmed = raw.trim().replace(/\/$/, "");
  const normalized = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;

  let url: URL;
  try {
    url = new URL(normalized);
  } catch {
    throw new McpError(ErrorCode.InvalidRequest, "ARM base URL is invalid");
  }

  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new McpError(ErrorCode.InvalidRequest, "ARM base URL must use http or https");
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new McpError(
      ErrorCode.InvalidRequest,
      "ARM base URL cannot contain credentials, query parameters, or a fragment",
    );
  }

  const isLoopback = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "::1";
  if (url.protocol === "http:" && !isLoopback && !getBooleanEnv("ARM_ALLOW_INSECURE_HTTP")) {
    throw new McpError(
      ErrorCode.InvalidRequest,
      "HTTP ARM base URLs require ARM_ALLOW_INSECURE_HTTP=true; use HTTPS for remote hosts",
    );
  }

  return url.toString().replace(/\/$/, "");
}

function getConfig(): ArmConfig {
  const baseUrl = process.env.ARM_BASE_URL?.trim();
  const apiToken = process.env.ARM_API_TOKEN?.trim();

  if (!baseUrl) {
    throw new McpError(ErrorCode.InvalidRequest, "Missing ARM_BASE_URL environment variable");
  }

  if (!apiToken) {
    throw new McpError(ErrorCode.InvalidRequest, "Missing ARM_API_TOKEN environment variable");
  }

  return {
    baseUrl: normalizeBaseUrl(baseUrl),
    apiToken,
    timeoutMs: getIntegerEnv("ARM_TIMEOUT_MS", 30000, 1000, 300000),
    maxRetries: getIntegerEnv("ARM_MAX_RETRIES", 2, 0, 10),
  };
}

function getAuditConfig(): AuditConfig {
  const baseUrl = process.env.ARM_AUDIT_BASE_URL?.trim();
  const bearerToken = process.env.ARM_AUDIT_API_TOKEN?.trim();

  if (!baseUrl) {
    throw new McpError(ErrorCode.InvalidRequest, "Missing ARM_AUDIT_BASE_URL environment variable");
  }

  if (!bearerToken) {
    throw new McpError(ErrorCode.InvalidRequest, "Missing ARM_AUDIT_API_TOKEN environment variable");
  }

  return {
    baseUrl: normalizeBaseUrl(baseUrl),
    bearerToken,
    timeoutMs: getIntegerEnv("ARM_AUDIT_TIMEOUT_MS", 30000, 1000, 300000),
    maxRetries: getIntegerEnv("ARM_AUDIT_MAX_RETRIES", 2, 0, 10),
    downloadDir: process.env.ARM_AUDIT_DOWNLOAD_DIR?.trim() || tmpdir(),
    maxDownloadBytes: getIntegerEnv(
      "ARM_AUDIT_MAX_DOWNLOAD_BYTES",
      50 * 1024 * 1024,
      1024,
      500 * 1024 * 1024,
    ),
  };
}

function isGenericToolEnabled(): boolean {
  return getBooleanEnv("ARM_ENABLE_GENERIC_TOOL");
}

function asJsonObject(value: unknown, fieldName: string): JsonObject | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    return value as JsonObject;
  }
  throw new McpError(ErrorCode.InvalidParams, `${fieldName} must be a JSON object`);
}

function getStringArg(value: unknown, fieldName: string, required = true): string | undefined {
  if (typeof value === "string" && value.trim().length > 0) return value.trim();
  if (!required && (value === undefined || value === null || value === "")) return undefined;
  throw new McpError(ErrorCode.InvalidParams, `${fieldName} must be a non-empty string`);
}

function getNumberArg(value: unknown, fieldName: string, required = true): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value.trim());
    if (Number.isFinite(parsed)) return parsed;
  }
  if (!required && (value === undefined || value === null || value === "")) return undefined;
  throw new McpError(ErrorCode.InvalidParams, `${fieldName} must be a finite number`);
}

function getBooleanArg(value: unknown, fieldName: string, required = true): boolean | undefined {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (normalized === "true") return true;
    if (normalized === "false") return false;
  }
  if (!required && (value === undefined || value === null || value === "")) return undefined;
  throw new McpError(ErrorCode.InvalidParams, `${fieldName} must be a boolean`);
}

function buildUrl(baseUrl: string, path: string, query?: JsonObject): string {
  const base = new URL(`${baseUrl}/`);
  const url = new URL(path, base);
  if (url.origin !== base.origin) {
    throw new McpError(ErrorCode.InvalidParams, "ARM request path must stay on ARM_BASE_URL");
  }
  if (query) {
    for (const [key, rawValue] of Object.entries(query)) {
      if (rawValue === undefined || rawValue === null) continue;
      if (Array.isArray(rawValue)) {
        for (const item of rawValue) {
          url.searchParams.append(key, String(item));
        }
      } else {
        url.searchParams.set(key, String(rawValue));
      }
    }
  }
  return url.toString();
}

async function parseResponseBody(response: Response): Promise<unknown> {
  const contentType = response.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    return response.json();
  }
  return response.text();
}

function responseHeaders(response: Response): Record<string, string> {
  const headers: Record<string, string> = {};
  response.headers.forEach((value, key) => {
    headers[key] = value;
  });
  return headers;
}

async function readBoundedResponseBody(response: Response, maxBytes: number): Promise<ArrayBuffer> {
  if (!response.body) return new ArrayBuffer(0);

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > maxBytes) {
        await reader.cancel("Audit download exceeded configured byte limit");
        throw new McpError(
          ErrorCode.InvalidRequest,
          `Audit download exceeds ARM_AUDIT_MAX_DOWNLOAD_BYTES (${maxBytes})`,
        );
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const body = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body.buffer;
}

function addExtraHeaders(headers: Record<string, string>, extraHeaders?: JsonObject): void {
  if (!extraHeaders) return;

  for (const [key, rawValue] of Object.entries(extraHeaders)) {
    if (rawValue === undefined || rawValue === null) continue;
    const normalizedKey = key.trim().toLowerCase();
    const value = String(rawValue);
    if (!normalizedKey || /[\r\n]/.test(key) || /[\r\n]/.test(value)) {
      throw new McpError(ErrorCode.InvalidParams, "Custom headers contain an invalid name or value");
    }
    if (PROTECTED_HEADERS.has(normalizedKey)) {
      throw new McpError(ErrorCode.InvalidParams, `Custom header ${key} cannot override protected headers`);
    }
    headers[key] = value;
  }
}

function retryDelayMs(response: Response | undefined, attempt: number): number {
  const retryAfter = response?.headers.get("retry-after")?.trim();
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, 30000);
    const date = Date.parse(retryAfter);
    if (Number.isFinite(date)) return Math.min(Math.max(date - Date.now(), 0), 30000);
  }

  const exponential = Math.min(300 * 2 ** attempt, 5000);
  return exponential + Math.floor(Math.random() * 101);
}

async function waitForRetry(response: Response | undefined, attempt: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, retryDelayMs(response, attempt)));
}

async function armRequest(args: {
  config: ArmConfig;
  path: string;
  method: HttpMethod;
  query?: JsonObject;
  body?: JsonObject;
  extraHeaders?: JsonObject;
  retryable?: boolean;
}): Promise<HttpResult> {
  const { config, path, method, query, body, extraHeaders, retryable = method === "GET" } = args;
  const url = buildUrl(config.baseUrl, path, query);

  if (method === "GET" && body !== undefined) {
    throw new McpError(ErrorCode.InvalidParams, "GET requests cannot include a request body");
  }

  const headers: Record<string, string> = {
    Accept: "application/json",
    token: config.apiToken,
  };

  if (body !== undefined) {
    headers["Content-Type"] = "application/json";
  }

  addExtraHeaders(headers, extraHeaders);

  for (let attempt = 0; attempt <= config.maxRetries; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), config.timeoutMs);

    try {
      const response = await fetch(url, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      });

      if (
        retryable &&
        RETRYABLE_HTTP_STATUSES.has(response.status) &&
        attempt < config.maxRetries
      ) {
        await response.arrayBuffer().catch(() => undefined);
        clearTimeout(timeout);
        await waitForRetry(response, attempt);
        continue;
      }

      const data = await parseResponseBody(response);
      return {
        status: response.status,
        data,
        headers: responseHeaders(response),
      };
    } catch (error) {
      if (!retryable || attempt >= config.maxRetries) {
        throw new McpError(
          ErrorCode.InternalError,
          `ARM request failed after ${attempt + 1} attempt(s): ${String(error)}`,
        );
      }
      await waitForRetry(undefined, attempt);
    } finally {
      clearTimeout(timeout);
    }
  }

  throw new McpError(ErrorCode.InternalError, "ARM request failed without a response");
}

async function auditRequest(args: {
  config: AuditConfig;
  path: string;
  method: HttpMethod;
  query?: JsonObject;
  responseMode?: "parsed" | "binary";
}): Promise<HttpResult> {
  const { config, path, method, query, responseMode = "parsed" } = args;
  const url = buildUrl(config.baseUrl, path, query);

  const headers: Record<string, string> = {
    Accept: responseMode === "binary" ? "application/zip" : "application/json",
    Authorization: `Bearer ${config.bearerToken}`,
  };

  for (let attempt = 0; attempt <= config.maxRetries; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), config.timeoutMs);

    try {
      const response = await fetch(url, {
        method,
        headers,
        signal: controller.signal,
      });

      if (
        RETRYABLE_HTTP_STATUSES.has(response.status) &&
        attempt < config.maxRetries
      ) {
        await response.arrayBuffer().catch(() => undefined);
        clearTimeout(timeout);
        await waitForRetry(response, attempt);
        continue;
      }

      let data: unknown;
      if (responseMode === "binary" && response.ok) {
        const contentLength = Number(response.headers.get("content-length"));
        if (Number.isFinite(contentLength) && contentLength > config.maxDownloadBytes) {
          await response.body?.cancel("Audit download exceeded configured byte limit");
          throw new McpError(
            ErrorCode.InvalidRequest,
            `Audit download exceeds ARM_AUDIT_MAX_DOWNLOAD_BYTES (${config.maxDownloadBytes})`,
          );
        }
        data = await readBoundedResponseBody(response, config.maxDownloadBytes);
      } else {
        data = await parseResponseBody(response);
      }

      return {
        status: response.status,
        data,
        headers: responseHeaders(response),
      };
    } catch (error) {
      if (error instanceof McpError || attempt >= config.maxRetries) {
        if (error instanceof McpError) throw error;
        throw new McpError(
          ErrorCode.InternalError,
          `Audit request failed after ${attempt + 1} attempt(s): ${String(error)}`,
        );
      }
      await waitForRetry(undefined, attempt);
    } finally {
      clearTimeout(timeout);
    }
  }

  throw new McpError(ErrorCode.InternalError, "Audit request failed without a response");
}

const AUDIT_EVENT_TYPES = [
  { eventType: "LOGIN", module: "Admin", description: "Login via Username/Password (UWP), VSCode apiToken, ChannelSecure, or Modernization jwtToken" },
  { eventType: "DEPLOYMENT", module: "CI Jobs, Deployment, Version Control", description: "CI Job Deployment, Quick Deployment, Rollback, Custom Deployment, Profile Manager, Org Synchronization, Commit/Merge Validation, Scratch Org creation" },
  { eventType: "CIBUILD", module: "CI Jobs", description: "Trigger Build and Build History events" },
  { eventType: "DATALOADER", module: "Single Dataloader", description: "Extract, Insert, Upsert, Update, Delete operations" },
  { eventType: "FEATUREDEPLOYMENT", module: "nCino", description: "All events related to the Feature Deployment module" },
  { eventType: "DATARETRIEVALMIGRATION", module: "nCino", description: "All Salesforce events involving data migration and retrieval" },
  { eventType: "FEATURECREATION", module: "nCino", description: "Events related to Feature Creation" },
  { eventType: "DATALOADERPRO", module: "Dataloader Pro", description: "Upsert, Data Masking, Applied Mapping, Filters" },
  { eventType: "DATALOADERCONFIGURATION", module: "Dataloader", description: "All events related to Dataloader Configurations" },
  { eventType: "TESTENVIRONMENTSETUP", module: "Dataloader", description: "Upsert and Applied Mappings" },
  { eventType: "EZCOMMIT", module: "Version Control", description: "Prevalidate Commit and EZ-Commit" },
  { eventType: "MERGE", module: "Version Control", description: "Dry Run, Prevalidate Merge, and Merge only" },
] as const;

const VALID_EVENT_TYPE_NAMES = AUDIT_EVENT_TYPES.map((e) => e.eventType);
const NCINO_CI_BASE_PATH = "/api/cijobs/v1/ncino";
const DEPLOYMENT_BASE_PATH = "/api/deployments/v1";
const DEPLOYMENT_STATUSES = ["Successful", "Failed", "In Progress"] as const;

function ncinoCiPath(path: string): string {
  return `${NCINO_CI_BASE_PATH}${path}`;
}

function getPositiveIntegerArg(
  value: unknown,
  fieldName: string,
  required = true,
): number | undefined {
  const parsed = getNumberArg(value, fieldName, required);
  if (parsed === undefined) return undefined;
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new McpError(ErrorCode.InvalidParams, `${fieldName} must be a positive integer`);
  }
  return parsed;
}

function isValidCalendarDate(date: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  const parsed = match
    ? new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])))
    : undefined;
  return Boolean(
    match &&
      parsed &&
      parsed.getUTCFullYear() === Number(match[1]) &&
      parsed.getUTCMonth() === Number(match[2]) - 1 &&
      parsed.getUTCDate() === Number(match[3]),
  );
}

function getDateArg(value: unknown, fieldName: string, required = true): string | undefined {
  const date = getStringArg(value, fieldName, required);
  if (date === undefined) return undefined;
  if (!isValidCalendarDate(date)) {
    throw new McpError(ErrorCode.InvalidParams, `${fieldName} must use YYYY-MM-DD format`);
  }
  return date;
}

function getIsoDateTimeArg(
  value: unknown,
  fieldName: string,
  required = true,
): string | undefined {
  const dateTime = getStringArg(value, fieldName, required);
  if (dateTime === undefined) return undefined;
  if (
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})?$/.test(
      dateTime,
    ) ||
    !Number.isFinite(Date.parse(dateTime)) ||
    !isValidCalendarDate(dateTime.slice(0, 10))
  ) {
    throw new McpError(
      ErrorCode.InvalidParams,
      `${fieldName} must use ISO 8601 date-time format`,
    );
  }
  return dateTime;
}

function parseDateValue(value: string): number {
  if (value.length === 10) return Date.parse(`${value}T00:00:00Z`);
  return Date.parse(/[zZ]|[+-]\d{2}:\d{2}$/.test(value) ? value : `${value}Z`);
}

function validateOrderedRange(
  start: string | undefined,
  end: string | undefined,
  startField: string,
  endField: string,
  maxDays?: number,
): void {
  if (!start || !end) return;
  const startMs = parseDateValue(start);
  const endMs = parseDateValue(end);
  if (endMs < startMs) {
    throw new McpError(ErrorCode.InvalidParams, `${endField} must not be before ${startField}`);
  }
  if (maxDays !== undefined && endMs - startMs > maxDays * 24 * 60 * 60 * 1000) {
    throw new McpError(
      ErrorCode.InvalidParams,
      `${endField} must be within ${maxDays} days of ${startField}`,
    );
  }
}

function getNcinoBuildNumber(args: Record<string, unknown>): number {
  return getPositiveIntegerArg(args.buildNumber, "buildNumber")!;
}

function getNcinoHeaders(args: Record<string, unknown>): JsonObject | undefined {
  return asJsonObject(args.headers, "headers");
}

function deploymentPath(path: string): string {
  return `${DEPLOYMENT_BASE_PATH}${path}`;
}

function getDeploymentLabel(args: Record<string, unknown>): string {
  return encodeURIComponent(getStringArg(args.label, "label")!);
}

function getDeploymentIterationSegment(args: Record<string, unknown>): string {
  return encodeURIComponent(
    String(getPositiveIntegerArg(args.iterationNumber, "iterationNumber")!),
  );
}

function getDeploymentHeaders(args: Record<string, unknown>): JsonObject | undefined {
  return asJsonObject(args.headers, "headers");
}

function formatToolResult(result: unknown): {
  content: Array<{ type: "text"; text: string }>;
  structuredContent: JsonObject;
  isError?: boolean;
} {
  const status =
    typeof result === "object" && result !== null && "status" in result
      ? (result as { status?: unknown }).status
      : undefined;
  const structuredContent =
    typeof result === "object" && result !== null && !Array.isArray(result)
      ? (result as JsonObject)
      : { data: result };

  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(result, null, 2) ?? "null",
      },
    ],
    structuredContent,
    ...(typeof status === "number" && status >= 400 ? { isError: true } : {}),
  };
}

const READ_ONLY_TOOL = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
} as const;
const MUTATING_TOOL = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: true,
} as const;
const TOOL_ANNOTATIONS: Record<
  string,
  {
    readOnlyHint: boolean;
    destructiveHint: boolean;
    idempotentHint: boolean;
    openWorldHint: boolean;
  }
> = {
  arm_quick_deploy: MUTATING_TOOL,
  arm_start_rollback: MUTATING_TOOL,
  arm_abort_ci_job: MUTATING_TOOL,
  arm_list_ci_jobs: READ_ONLY_TOOL,
  arm_ci_job_history: READ_ONLY_TOOL,
  arm_latest_results: READ_ONLY_TOOL,
  arm_poll_job_status: READ_ONLY_TOOL,
  arm_rollback_history: READ_ONLY_TOOL,
  arm_rollback_details: READ_ONLY_TOOL,
  arm_trigger_build: MUTATING_TOOL,
  arm_update_baseline_revision: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
  arm_ncino_list_ci_jobs: READ_ONLY_TOOL,
  arm_ncino_list_job_history: READ_ONLY_TOOL,
  arm_ncino_trigger_build: MUTATING_TOOL,
  arm_ncino_get_build_summary: READ_ONLY_TOOL,
  arm_ncino_get_latest_build: READ_ONLY_TOOL,
  arm_ncino_get_build_history: READ_ONLY_TOOL,
  arm_ncino_poll_build_status: READ_ONLY_TOOL,
  arm_list_deployments: READ_ONLY_TOOL,
  arm_get_deployment: READ_ONLY_TOOL,
  arm_get_deployment_components: READ_ONLY_TOOL,
  arm_get_deployment_stories: READ_ONLY_TOOL,
  arm_get_deployment_promotion_log: READ_ONLY_TOOL,
  arm_get_deployment_test_coverage: READ_ONLY_TOOL,
  arm_call_api: MUTATING_TOOL,
  arm_audit_get_logs: READ_ONLY_TOOL,
  arm_audit_download_logs: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: true,
  },
  arm_audit_list_event_types: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
};

const TOOL_OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: true,
} as const;

const server = new Server(
  {
    name: "arm-mcp-server",
    version: "0.5.0",
  },
  {
    capabilities: {
      tools: {},
      resources: {},
      prompts: {},
    },
  },
);

server.setRequestHandler(ListToolsRequestSchema, async () => {
  const tools = [
      {
        name: "arm_quick_deploy",
        description:
          "POST /api/cijobs/v1/triggerquickdeploy/{ciJobName}/{buildNumber?}. Triggers quick deploy.",
        inputSchema: {
          type: "object",
          properties: {
            ciJobName: {
              type: "string",
              description: "Case-sensitive CI job name",
            },
            buildNumber: {
              type: "integer",
              minimum: 1,
              description: "Optional build number. If omitted, latest build is used.",
            },
            projectName: {
              type: "string",
              description: "Case-sensitive CI job project name",
            },
            title: {
              type: "string",
              description: "CI job build label",
            },
            headers: {
              type: "object",
              description: "Optional extra headers",
              additionalProperties: true,
            },
          },
          required: ["ciJobName", "projectName", "title"],
          additionalProperties: false,
        },
      },
      {
        name: "arm_start_rollback",
        description: "POST /api/cijobs/v1/rollback. Initiates rollback operation for CI job.",
        inputSchema: {
          type: "object",
          properties: {
            projectName: {
              type: "string",
              description: "Case-sensitive CI job project name",
            },
            title: {
              type: "string",
              description: "CI job build label",
            },
            headers: {
              type: "object",
              description: "Optional extra headers",
              additionalProperties: true,
            },
          },
          required: ["projectName", "title"],
          additionalProperties: false,
        },
      },
      {
        name: "arm_abort_ci_job",
        description: "PUT /api/cijobs/v1/abort/{ciJobName}/{buildNumber?}. Aborts ongoing CI job.",
        inputSchema: {
          type: "object",
          properties: {
            ciJobName: {
              type: "string",
              description: "Case-sensitive CI job name",
            },
            buildNumber: {
              type: "integer",
              minimum: 1,
              description: "Optional build number. If omitted, latest build is used.",
            },
            projectName: {
              type: "string",
              description: "Case-sensitive CI job project name",
            },
            title: {
              type: "string",
              description: "CI job build label",
            },
            headers: {
              type: "object",
              description: "Optional extra headers",
              additionalProperties: true,
            },
          },
          required: ["ciJobName", "projectName", "title"],
          additionalProperties: false,
        },
      },
      {
        name: "arm_list_ci_jobs",
        description:
          "GET /api/cijobs/v1/listcijobs. Lists all CI jobs configured in ARM.",
        inputSchema: {
          type: "object",
          properties: {
            headers: {
              type: "object",
              description: "Optional extra headers",
              additionalProperties: true,
            },
          },
          additionalProperties: false,
        },
      },
      {
        name: "arm_ci_job_history",
        description:
          "GET /api/cijobs/v1/history/{ciJobName}. Retrieves CI job build history.",
        inputSchema: {
          type: "object",
          properties: {
            ciJobName: {
              type: "string",
              description: "Case-sensitive CI job name",
            },
            from: {
              type: "integer",
              minimum: -1,
              description: "Start index for history range. Defaults to -1 (all).",
            },
            to: {
              type: "integer",
              minimum: -1,
              description: "End index for history range. Defaults to -1 (all).",
            },
            headers: {
              type: "object",
              description: "Optional extra headers",
              additionalProperties: true,
            },
          },
          required: ["ciJobName"],
          additionalProperties: false,
        },
      },
      {
        name: "arm_latest_results",
        description:
          "GET /api/cijobs/v1/latestresults/{ciJobName}. Retrieves detailed latest results for a CI job.",
        inputSchema: {
          type: "object",
          properties: {
            ciJobName: {
              type: "string",
              description: "Case-sensitive CI job name",
            },
            headers: {
              type: "object",
              description: "Optional extra headers",
              additionalProperties: true,
            },
          },
          required: ["ciJobName"],
          additionalProperties: false,
        },
      },
      {
        name: "arm_poll_job_status",
        description:
          "GET /api/cijobs/v1/pollstatus/{ciJobName}/{buildNumber?}. Polls the current status of a CI job build.",
        inputSchema: {
          type: "object",
          properties: {
            ciJobName: {
              type: "string",
              description: "Case-sensitive CI job name",
            },
            buildNumber: {
              type: "integer",
              minimum: 1,
              description: "Optional build number. If omitted, latest build is used.",
            },
            headers: {
              type: "object",
              description: "Optional extra headers",
              additionalProperties: true,
            },
          },
          required: ["ciJobName"],
          additionalProperties: false,
        },
      },
      {
        name: "arm_rollback_history",
        description:
          "GET /api/cijobs/v1/rollback/history/{ciJobName}/{buildNumber?}. Fetches rollback history for a CI job build.",
        inputSchema: {
          type: "object",
          properties: {
            ciJobName: {
              type: "string",
              description: "Case-sensitive CI job name",
            },
            buildNumber: {
              type: "integer",
              minimum: 1,
              description: "Optional build number. If omitted, latest build is used.",
            },
            headers: {
              type: "object",
              description: "Optional extra headers",
              additionalProperties: true,
            },
          },
          required: ["ciJobName"],
          additionalProperties: false,
        },
      },
      {
        name: "arm_rollback_details",
        description:
          "GET /api/cijobs/v1/rollback/{ciJobName}. Retrieves complete rollback information for a CI job.",
        inputSchema: {
          type: "object",
          properties: {
            ciJobName: {
              type: "string",
              description: "Case-sensitive CI job name",
            },
            headers: {
              type: "object",
              description: "Optional extra headers",
              additionalProperties: true,
            },
          },
          required: ["ciJobName"],
          additionalProperties: false,
        },
      },
      {
        name: "arm_trigger_build",
        description:
          "POST /api/cijobs/v1/trigger. Triggers a new build for a CI job.",
        inputSchema: {
          type: "object",
          properties: {
            projectName: {
              type: "string",
              description: "Case-sensitive CI job project name",
            },
            title: {
              type: "string",
              description: "CI job build label",
            },
            headers: {
              type: "object",
              description: "Optional extra headers",
              additionalProperties: true,
            },
          },
          required: ["projectName", "title"],
          additionalProperties: false,
        },
      },
      {
        name: "arm_update_baseline_revision",
        description:
          "POST /api/cijobs/v1/update/baselinerevision. Updates the baseline revision for a CI job.",
        inputSchema: {
          type: "object",
          properties: {
            projectName: {
              type: "string",
              description: "Case-sensitive CI job project name",
            },
            baseLineRevision: {
              type: "string",
              description: "Baseline revision number/hash for the CI job",
            },
            headers: {
              type: "object",
              description: "Optional extra headers",
              additionalProperties: true,
            },
          },
          required: ["projectName", "baseLineRevision"],
          additionalProperties: false,
        },
      },
      {
        name: "arm_ncino_list_ci_jobs",
        description:
          "GET /api/cijobs/v1/ncino/getalljobs. Lists nCino-enabled CI jobs and their org, repository, branch, destination, and job type details.",
        inputSchema: {
          type: "object",
          properties: {
            headers: {
              type: "object",
              description: "Optional extra headers",
              additionalProperties: true,
            },
          },
          additionalProperties: false,
        },
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: true,
        },
      },
      {
        name: "arm_ncino_list_job_history",
        description:
          "GET /api/cijobs/v1/ncino/gethistory. Lists nCino CI job build history across projects.",
        inputSchema: {
          type: "object",
          properties: {
            headers: {
              type: "object",
              description: "Optional extra headers",
              additionalProperties: true,
            },
          },
          additionalProperties: false,
        },
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: true,
        },
      },
      {
        name: "arm_ncino_trigger_build",
        description:
          "POST /api/cijobs/v1/ncino/trigger. Triggers an nCino CI job build with explicit deploy and feature-commit behavior.",
        inputSchema: {
          type: "object",
          properties: {
            jobName: {
              type: "string",
              description: "Case-sensitive nCino CI job name",
            },
            title: {
              type: "string",
              description: "Build label",
            },
            deploy: {
              type: "boolean",
              description: "Whether the build should deploy",
            },
            commitFeature: {
              type: "boolean",
              description: "Whether the build should commit the nCino feature",
            },
            note: {
              type: "string",
              description: "Optional build note",
            },
            comment: {
              type: "string",
              description: "Optional build comment",
            },
            rollbackEnabled: {
              type: "boolean",
              description: "Optional rollback setting for the build",
            },
            deployedSFOrg: {
              type: "string",
              description: "Optional destination Salesforce org name",
            },
            projectType: {
              type: "string",
              description:
                "Optional project type accepted by ARM. The published example uses SalesForceFeature.",
            },
            headers: {
              type: "object",
              description: "Optional extra headers",
              additionalProperties: true,
            },
          },
          required: ["jobName", "title", "deploy", "commitFeature"],
          additionalProperties: false,
        },
        annotations: {
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: false,
          openWorldHint: true,
        },
      },
      {
        name: "arm_ncino_get_build_summary",
        description:
          "POST /api/cijobs/v1/ncino/getcijobsummary. Retrieves build summaries for a case-sensitive nCino CI job name.",
        inputSchema: {
          type: "object",
          properties: {
            jobName: {
              type: "string",
              description: "Case-sensitive nCino CI job name",
            },
            nextPage: {
              type: "boolean",
              description: "Optional pagination flag accepted by the published request body",
            },
            headers: {
              type: "object",
              description: "Optional extra headers",
              additionalProperties: true,
            },
          },
          required: ["jobName"],
          additionalProperties: false,
        },
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: true,
        },
      },
      {
        name: "arm_ncino_get_latest_build",
        description:
          "POST /api/cijobs/v1/ncino/getcijobinfo. Retrieves the latest build details for an nCino CI job.",
        inputSchema: {
          type: "object",
          properties: {
            jobName: {
              type: "string",
              description: "Case-sensitive nCino CI job name",
            },
            headers: {
              type: "object",
              description: "Optional extra headers",
              additionalProperties: true,
            },
          },
          required: ["jobName"],
          additionalProperties: false,
        },
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: true,
        },
      },
      {
        name: "arm_ncino_get_build_history",
        description:
          "POST /api/cijobs/v1/ncino/getcijobbuildhistory. Retrieves feature and deployment results for a specific nCino CI job build.",
        inputSchema: {
          type: "object",
          properties: {
            jobName: {
              type: "string",
              description: "Case-sensitive nCino CI job name",
            },
            buildNumber: {
              type: "integer",
              minimum: 1,
              description: "Positive nCino CI job build number",
            },
            headers: {
              type: "object",
              description: "Optional extra headers",
              additionalProperties: true,
            },
          },
          required: ["jobName", "buildNumber"],
          additionalProperties: false,
        },
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: true,
        },
      },
      {
        name: "arm_ncino_poll_build_status",
        description:
          "POST /api/cijobs/v1/ncino/pollstatus. Polls build, deployment, post-deployment, and rollback status for a specific nCino CI job build.",
        inputSchema: {
          type: "object",
          properties: {
            jobName: {
              type: "string",
              description: "Case-sensitive nCino CI job name",
            },
            buildNumber: {
              type: "integer",
              minimum: 1,
              description: "Positive nCino CI job build number",
            },
            headers: {
              type: "object",
              description: "Optional extra headers",
              additionalProperties: true,
            },
          },
          required: ["jobName", "buildNumber"],
          additionalProperties: false,
        },
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: true,
        },
      },
      {
        name: "arm_list_deployments",
        description:
          "GET /api/deployments/v1/list. Lists deployments with optional status, date range, label, destination org, and limit filters.",
        inputSchema: {
          type: "object",
          properties: {
            status: {
              type: "string",
              enum: DEPLOYMENT_STATUSES,
              description: "Optional deployment status filter",
            },
            fromDate: {
              type: "string",
              description: "Optional start date filter in YYYY-MM-DD format",
            },
            toDate: {
              type: "string",
              description: "Optional end date filter in YYYY-MM-DD format",
            },
            labelName: {
              type: "string",
              description: "Optional deployment label name filter",
            },
            destSfOrg: {
              type: "string",
              description: "Optional destination Salesforce org filter",
            },
            limit: {
              type: "integer",
              minimum: 1,
              maximum: 100,
              description: "Optional maximum number of deployments to return. Maximum 100.",
            },
            headers: {
              type: "object",
              description: "Optional extra headers",
              additionalProperties: true,
            },
          },
          additionalProperties: false,
        },
      },
      {
        name: "arm_get_deployment",
        description:
          "GET /api/deployments/v1/{label}. Retrieves deployment-level details for a deployment label.",
        inputSchema: {
          type: "object",
          properties: {
            label: {
              type: "string",
              description: "Deployment label name",
            },
            headers: {
              type: "object",
              description: "Optional extra headers",
              additionalProperties: true,
            },
          },
          required: ["label"],
          additionalProperties: false,
        },
      },
      {
        name: "arm_get_deployment_components",
        description:
          "GET /api/deployments/v1/{label}/components. Retrieves component-level changes for a deployment.",
        inputSchema: {
          type: "object",
          properties: {
            label: {
              type: "string",
              description: "Deployment label name",
            },
            headers: {
              type: "object",
              description: "Optional extra headers",
              additionalProperties: true,
            },
          },
          required: ["label"],
          additionalProperties: false,
        },
      },
      {
        name: "arm_get_deployment_stories",
        description:
          "GET /api/deployments/v1/{label}/stories. Retrieves Jira stories and commit traceability for a deployment, optionally scoped to an iteration.",
        inputSchema: {
          type: "object",
          properties: {
            label: {
              type: "string",
              description: "Deployment label name",
            },
            iterationNumber: {
              type: "integer",
              minimum: 1,
              description: "Optional deployment iteration number",
            },
            headers: {
              type: "object",
              description: "Optional extra headers",
              additionalProperties: true,
            },
          },
          required: ["label"],
          additionalProperties: false,
        },
      },
      {
        name: "arm_get_deployment_promotion_log",
        description:
          "GET /api/deployments/v1/{label}/logs/{iterationNumber}. Retrieves the plain-text promotion log for a deployment iteration.",
        inputSchema: {
          type: "object",
          properties: {
            label: {
              type: "string",
              description: "Deployment label name",
            },
            iterationNumber: {
              type: "integer",
              minimum: 1,
              description: "Deployment iteration number",
            },
            headers: {
              type: "object",
              description: "Optional extra headers",
              additionalProperties: true,
            },
          },
          required: ["label", "iterationNumber"],
          additionalProperties: false,
        },
      },
      {
        name: "arm_get_deployment_test_coverage",
        description:
          "GET /api/deployments/v1/{label}/coverage/{iterationNumber}. Retrieves Apex test and code coverage details for a deployment iteration.",
        inputSchema: {
          type: "object",
          properties: {
            label: {
              type: "string",
              description: "Deployment label name",
            },
            iterationNumber: {
              type: "integer",
              minimum: 1,
              description: "Deployment iteration number",
            },
            headers: {
              type: "object",
              description: "Optional extra headers",
              additionalProperties: true,
            },
          },
          required: ["label", "iterationNumber"],
          additionalProperties: false,
        },
      },
      {
        name: "arm_call_api",
        description:
          "Optional generic ARM API request tool for /api endpoints not yet modeled as dedicated tools. Disabled unless ARM_ENABLE_GENERIC_TOOL=true.",
        inputSchema: {
          type: "object",
          properties: {
            path: {
              type: "string",
              description: "Endpoint path starting with /api/...",
            },
            method: {
              type: "string",
              enum: ["GET", "POST", "PUT", "PATCH", "DELETE"],
            },
            query: {
              type: "object",
              additionalProperties: true,
            },
            body: {
              type: "object",
              additionalProperties: true,
            },
            headers: {
              type: "object",
              additionalProperties: true,
            },
          },
          required: ["path", "method"],
          additionalProperties: false,
        },
      },
      {
        name: "arm_audit_get_logs",
        description:
          "GET /logs/audit_logs. Retrieves SIEM audit logs from AutoRABIT with optional filters. Returns CEF-formatted log entries.",
        inputSchema: {
          type: "object",
          properties: {
            startTime: {
              type: "string",
              description:
                "Start time in ISO 8601 format (YYYY-MM-DDThh:mm:ss). Defaults to current day if omitted.",
            },
            maxResults: {
              type: "integer",
              minimum: 1,
              description: "Maximum number of results to return. Default is 1000.",
            },
            eventType: {
              type: "string",
              description:
                "Comma-separated event types to filter. Valid values: LOGIN, DEPLOYMENT, CIBUILD, DATALOADER, FEATUREDEPLOYMENT, DATARETRIEVALMIGRATION, FEATURECREATION, DATALOADERPRO, DATALOADERCONFIGURATION, TESTENVIRONMENTSETUP, EZCOMMIT, MERGE. If omitted, all events are returned.",
            },
          },
          additionalProperties: false,
        },
      },
      {
        name: "arm_audit_download_logs",
        description:
          "GET /logs/audit_logs/download. Downloads a bounded SIEM audit ZIP to ARM_AUDIT_DOWNLOAD_DIR and returns a local resource link. The date range is limited to 90 days.",
        inputSchema: {
          type: "object",
          properties: {
            startTime: {
              type: "string",
              description: "Start date in ISO 8601 format (YYYY-MM-DDThh:mm:ss). Required.",
            },
            endTime: {
              type: "string",
              description:
                "End date in ISO 8601 format (YYYY-MM-DDThh:mm:ss). Optional; defaults to current day. Range must be within 90 days of startTime.",
            },
          },
          required: ["startTime"],
          additionalProperties: false,
        },
      },
      {
        name: "arm_audit_list_event_types",
        description:
          "Returns the 12 known ARM SIEM audit event types with their associated modules and descriptions. No API call is made; this is a local reference.",
        inputSchema: {
          type: "object",
          properties: {},
          additionalProperties: false,
        },
      },
    ];

  return {
    tools: tools
      .filter((tool) => tool.name !== "arm_call_api" || isGenericToolEnabled())
      .map((tool) => ({
        ...tool,
        annotations: TOOL_ANNOTATIONS[tool.name],
        outputSchema: TOOL_OUTPUT_SCHEMA,
      })),
  };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const toolName = request.params.name;
  const args = request.params.arguments ?? {};

  // --- Audit log tools (separate config + Bearer auth) ---

  if (toolName === "arm_audit_list_event_types") {
    return formatToolResult(AUDIT_EVENT_TYPES);
  }

  if (toolName === "arm_audit_get_logs") {
    const auditConfig = getAuditConfig();
    const query: JsonObject = {};

    const startTime = getIsoDateTimeArg(args.startTime, "startTime", false);
    if (startTime) query.startTime = startTime;

    const maxResults = getPositiveIntegerArg(args.maxResults, "maxResults", false);
    if (maxResults !== undefined) query.maxResults = maxResults;

    const eventTypeRaw = getStringArg(args.eventType, "eventType", false);
    if (eventTypeRaw) {
      const types = eventTypeRaw.split(",").map((t) => t.trim());
      for (const t of types) {
        if (!VALID_EVENT_TYPE_NAMES.includes(t as (typeof VALID_EVENT_TYPE_NAMES)[number])) {
          throw new McpError(
            ErrorCode.InvalidParams,
            `Invalid eventType "${t}". Valid values: ${VALID_EVENT_TYPE_NAMES.join(", ")}`,
          );
        }
      }
      query.eventType = eventTypeRaw;
    }

    const result = await auditRequest({
      config: auditConfig,
      path: "/logs/audit_logs",
      method: "GET",
      query,
    });

    return formatToolResult(result);
  }

  if (toolName === "arm_audit_download_logs") {
    const auditConfig = getAuditConfig();
    const startTime = getIsoDateTimeArg(args.startTime, "startTime")!;
    const endTime = getIsoDateTimeArg(args.endTime, "endTime", false);
    validateOrderedRange(startTime, endTime, "startTime", "endTime", 90);

    const query: JsonObject = { startTime };
    if (endTime) query.endTime = endTime;

    const downloadUrl = buildUrl(auditConfig.baseUrl, "/logs/audit_logs/download", query);

    const result = await auditRequest({
      config: auditConfig,
      path: "/logs/audit_logs/download",
      method: "GET",
      query,
      responseMode: "binary",
    });

    if (result.status >= 400) return formatToolResult(result);
    if (!(result.data instanceof ArrayBuffer)) {
      throw new McpError(ErrorCode.InternalError, "Audit download did not return binary data");
    }

    await mkdir(auditConfig.downloadDir, { recursive: true });
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const suffix = Math.random().toString(36).slice(2, 8);
    const filename = `arm-audit-logs-${timestamp}-${suffix}.zip`;
    const filePath = resolve(auditConfig.downloadDir, filename);
    const bytes = Buffer.from(result.data);
    await writeFile(filePath, bytes, { flag: "wx", mode: 0o600 });

    const metadata: JsonObject = {
      status: result.status,
      downloadUrl,
      filePath,
      bytes: bytes.byteLength,
      startTime,
      endTime: endTime ?? "(current day)",
      headers: result.headers,
    };

    return {
      content: [
        { type: "text" as const, text: JSON.stringify(metadata, null, 2) },
        {
          type: "resource_link" as const,
          name: filename,
          uri: pathToFileURL(filePath).href,
          description: "Downloaded AutoRABIT audit logs ZIP",
          mimeType: result.headers["content-type"] || "application/zip",
          size: bytes.byteLength,
        },
      ],
      structuredContent: metadata,
    };
  }

  // --- CI Jobs tools (ARM config + token header auth) ---

  if (toolName === "arm_call_api" && !isGenericToolEnabled()) {
    throw new McpError(
      ErrorCode.InvalidRequest,
      "arm_call_api is disabled; set ARM_ENABLE_GENERIC_TOOL=true to enable it",
    );
  }

  const config = getConfig();

  if (toolName === "arm_quick_deploy") {
    const ciJobName = encodeURIComponent(getStringArg(args.ciJobName, "ciJobName")!);
    const buildNumber = getPositiveIntegerArg(args.buildNumber, "buildNumber", false);
    const buildSegment = buildNumber === undefined ? "" : `/${buildNumber}`;

    const result = await armRequest({
      config,
      path: `/api/cijobs/v1/triggerquickdeploy/${ciJobName}${buildSegment}`,
      method: "POST",
      body: {
        projectName: getStringArg(args.projectName, "projectName"),
        title: getStringArg(args.title, "title"),
      },
      extraHeaders: asJsonObject(args.headers, "headers"),
    });

    return formatToolResult(result);
  }

  if (toolName === "arm_start_rollback") {
    const result = await armRequest({
      config,
      path: "/api/cijobs/v1/rollback",
      method: "POST",
      body: {
        projectName: getStringArg(args.projectName, "projectName"),
        title: getStringArg(args.title, "title"),
      },
      extraHeaders: asJsonObject(args.headers, "headers"),
    });

    return formatToolResult(result);
  }

  if (toolName === "arm_abort_ci_job") {
    const ciJobName = encodeURIComponent(getStringArg(args.ciJobName, "ciJobName")!);
    const buildNumber = getPositiveIntegerArg(args.buildNumber, "buildNumber", false);
    const buildSegment = buildNumber === undefined ? "" : `/${buildNumber}`;

    const result = await armRequest({
      config,
      path: `/api/cijobs/v1/abort/${ciJobName}${buildSegment}`,
      method: "PUT",
      body: {
        projectName: getStringArg(args.projectName, "projectName"),
        title: getStringArg(args.title, "title"),
      },
      extraHeaders: asJsonObject(args.headers, "headers"),
    });

    return formatToolResult(result);
  }

  if (toolName === "arm_list_ci_jobs") {
    const result = await armRequest({
      config,
      path: "/api/cijobs/v1/listcijobs",
      method: "GET",
      extraHeaders: asJsonObject(args.headers, "headers"),
    });

    return formatToolResult(result);
  }

  if (toolName === "arm_ci_job_history") {
    const ciJobName = encodeURIComponent(getStringArg(args.ciJobName, "ciJobName")!);
    const from = getNumberArg(args.from, "from", false) ?? -1;
    const to = getNumberArg(args.to, "to", false) ?? -1;
    if (!Number.isInteger(from) || from < -1) {
      throw new McpError(ErrorCode.InvalidParams, "from must be an integer of -1 or greater");
    }
    if (!Number.isInteger(to) || to < -1) {
      throw new McpError(ErrorCode.InvalidParams, "to must be an integer of -1 or greater");
    }
    const query: JsonObject = {};
    query.from = from;
    query.to = to;

    const result = await armRequest({
      config,
      path: `/api/cijobs/v1/history/${ciJobName}`,
      method: "GET",
      query,
      extraHeaders: asJsonObject(args.headers, "headers"),
    });

    return formatToolResult(result);
  }

  if (toolName === "arm_latest_results") {
    const ciJobName = encodeURIComponent(getStringArg(args.ciJobName, "ciJobName")!);

    const result = await armRequest({
      config,
      path: `/api/cijobs/v1/latestresults/${ciJobName}`,
      method: "GET",
      extraHeaders: asJsonObject(args.headers, "headers"),
    });

    return formatToolResult(result);
  }

  if (toolName === "arm_poll_job_status") {
    const ciJobName = encodeURIComponent(getStringArg(args.ciJobName, "ciJobName")!);
    const buildNumber = getPositiveIntegerArg(args.buildNumber, "buildNumber", false);
    const buildSegment = buildNumber === undefined ? "" : `/${buildNumber}`;

    const result = await armRequest({
      config,
      path: `/api/cijobs/v1/pollstatus/${ciJobName}${buildSegment}`,
      method: "GET",
      extraHeaders: asJsonObject(args.headers, "headers"),
    });

    return formatToolResult(result);
  }

  if (toolName === "arm_rollback_history") {
    const ciJobName = encodeURIComponent(getStringArg(args.ciJobName, "ciJobName")!);
    const buildNumber = getPositiveIntegerArg(args.buildNumber, "buildNumber", false);
    const buildSegment = buildNumber === undefined ? "" : `/${buildNumber}`;

    const result = await armRequest({
      config,
      path: `/api/cijobs/v1/rollback/history/${ciJobName}${buildSegment}`,
      method: "GET",
      extraHeaders: asJsonObject(args.headers, "headers"),
    });

    return formatToolResult(result);
  }

  if (toolName === "arm_rollback_details") {
    const ciJobName = encodeURIComponent(getStringArg(args.ciJobName, "ciJobName")!);

    const result = await armRequest({
      config,
      path: `/api/cijobs/v1/rollback/${ciJobName}`,
      method: "GET",
      extraHeaders: asJsonObject(args.headers, "headers"),
    });

    return formatToolResult(result);
  }

  if (toolName === "arm_trigger_build") {
    const result = await armRequest({
      config,
      path: "/api/cijobs/v1/trigger",
      method: "POST",
      body: {
        projectName: getStringArg(args.projectName, "projectName"),
        title: getStringArg(args.title, "title"),
      },
      extraHeaders: asJsonObject(args.headers, "headers"),
    });

    return formatToolResult(result);
  }

  if (toolName === "arm_update_baseline_revision") {
    const result = await armRequest({
      config,
      path: "/api/cijobs/v1/update/baselinerevision",
      method: "POST",
      body: {
        projectName: getStringArg(args.projectName, "projectName"),
        baseLineRevision: getStringArg(args.baseLineRevision, "baseLineRevision"),
      },
      extraHeaders: asJsonObject(args.headers, "headers"),
    });

    return formatToolResult(result);
  }

  if (toolName === "arm_ncino_list_ci_jobs") {
    const result = await armRequest({
      config,
      path: ncinoCiPath("/getalljobs"),
      method: "GET",
      extraHeaders: getNcinoHeaders(args),
    });

    return formatToolResult(result);
  }

  if (toolName === "arm_ncino_list_job_history") {
    const result = await armRequest({
      config,
      path: ncinoCiPath("/gethistory"),
      method: "GET",
      extraHeaders: getNcinoHeaders(args),
    });

    return formatToolResult(result);
  }

  if (toolName === "arm_ncino_trigger_build") {
    const jobHistory: JsonObject = {
      title: getStringArg(args.title, "title"),
      deploy: getBooleanArg(args.deploy, "deploy"),
      commitFeature: getBooleanArg(args.commitFeature, "commitFeature"),
      note: getStringArg(args.note, "note", false),
      comment: getStringArg(args.comment, "comment", false),
      rollbackEnabled: getBooleanArg(args.rollbackEnabled, "rollbackEnabled", false),
      deployedSFOrg: getStringArg(args.deployedSFOrg, "deployedSFOrg", false),
      projectType: getStringArg(args.projectType, "projectType", false),
    };

    const result = await armRequest({
      config,
      path: ncinoCiPath("/trigger"),
      method: "POST",
      body: {
        jobName: getStringArg(args.jobName, "jobName"),
        jobHistory,
      },
      extraHeaders: getNcinoHeaders(args),
    });

    return formatToolResult(result);
  }

  if (toolName === "arm_ncino_get_build_summary") {
    const result = await armRequest({
      config,
      path: ncinoCiPath("/getcijobsummary"),
      method: "POST",
      body: {
        jobName: getStringArg(args.jobName, "jobName"),
        nextPage: getBooleanArg(args.nextPage, "nextPage", false),
      },
      extraHeaders: getNcinoHeaders(args),
      retryable: true,
    });

    return formatToolResult(result);
  }

  if (toolName === "arm_ncino_get_latest_build") {
    const result = await armRequest({
      config,
      path: ncinoCiPath("/getcijobinfo"),
      method: "POST",
      body: {
        jobName: getStringArg(args.jobName, "jobName"),
      },
      extraHeaders: getNcinoHeaders(args),
      retryable: true,
    });

    return formatToolResult(result);
  }

  if (toolName === "arm_ncino_get_build_history") {
    const result = await armRequest({
      config,
      path: ncinoCiPath("/getcijobbuildhistory"),
      method: "POST",
      body: {
        jobName: getStringArg(args.jobName, "jobName"),
        buildNumber: getNcinoBuildNumber(args),
      },
      extraHeaders: getNcinoHeaders(args),
      retryable: true,
    });

    return formatToolResult(result);
  }

  if (toolName === "arm_ncino_poll_build_status") {
    const result = await armRequest({
      config,
      path: ncinoCiPath("/pollstatus"),
      method: "POST",
      body: {
        jobName: getStringArg(args.jobName, "jobName"),
        buildNumber: getNcinoBuildNumber(args),
      },
      extraHeaders: getNcinoHeaders(args),
      retryable: true,
    });

    return formatToolResult(result);
  }

  if (toolName === "arm_list_deployments") {
    const query: JsonObject = {};

    const status = getStringArg(args.status, "status", false);
    if (status) {
      if (!DEPLOYMENT_STATUSES.includes(status as (typeof DEPLOYMENT_STATUSES)[number])) {
        throw new McpError(
          ErrorCode.InvalidParams,
          `Invalid status "${status}". Valid values: ${DEPLOYMENT_STATUSES.join(", ")}`,
        );
      }
      query.status = status;
    }

    const fromDate = getDateArg(args.fromDate, "fromDate", false);
    if (fromDate) query.fromDate = fromDate;

    const toDate = getDateArg(args.toDate, "toDate", false);
    if (toDate) query.toDate = toDate;
    validateOrderedRange(fromDate, toDate, "fromDate", "toDate");

    const labelName = getStringArg(args.labelName, "labelName", false);
    if (labelName) query.labelName = labelName;

    const destSfOrg = getStringArg(args.destSfOrg, "destSfOrg", false);
    if (destSfOrg) query.destSfOrg = destSfOrg;

    const limit = getNumberArg(args.limit, "limit", false);
    if (limit !== undefined) {
      if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
        throw new McpError(ErrorCode.InvalidParams, "limit must be an integer from 1 to 100");
      }
      query.limit = limit;
    }

    const result = await armRequest({
      config,
      path: deploymentPath("/list"),
      method: "GET",
      query,
      extraHeaders: getDeploymentHeaders(args),
    });

    return formatToolResult(result);
  }

  if (toolName === "arm_get_deployment") {
    const label = getDeploymentLabel(args);

    const result = await armRequest({
      config,
      path: deploymentPath(`/${label}`),
      method: "GET",
      extraHeaders: getDeploymentHeaders(args),
    });

    return formatToolResult(result);
  }

  if (toolName === "arm_get_deployment_components") {
    const label = getDeploymentLabel(args);

    const result = await armRequest({
      config,
      path: deploymentPath(`/${label}/components`),
      method: "GET",
      extraHeaders: getDeploymentHeaders(args),
    });

    return formatToolResult(result);
  }

  if (toolName === "arm_get_deployment_stories") {
    const label = getDeploymentLabel(args);
    const iterationNumber = getPositiveIntegerArg(
      args.iterationNumber,
      "iterationNumber",
      false,
    );
    const query: JsonObject = {};
    if (iterationNumber !== undefined) query.iterationNumber = iterationNumber;

    const result = await armRequest({
      config,
      path: deploymentPath(`/${label}/stories`),
      method: "GET",
      query,
      extraHeaders: getDeploymentHeaders(args),
    });

    return formatToolResult(result);
  }

  if (toolName === "arm_get_deployment_promotion_log") {
    const label = getDeploymentLabel(args);
    const iterationNumber = getDeploymentIterationSegment(args);

    const result = await armRequest({
      config,
      path: deploymentPath(`/${label}/logs/${iterationNumber}`),
      method: "GET",
      extraHeaders: getDeploymentHeaders(args),
    });

    return formatToolResult(result);
  }

  if (toolName === "arm_get_deployment_test_coverage") {
    const label = getDeploymentLabel(args);
    const iterationNumber = getDeploymentIterationSegment(args);

    const result = await armRequest({
      config,
      path: deploymentPath(`/${label}/coverage/${iterationNumber}`),
      method: "GET",
      extraHeaders: getDeploymentHeaders(args),
    });

    return formatToolResult(result);
  }

  if (toolName === "arm_call_api") {
    const path = typeof args.path === "string" ? args.path : undefined;
    const method = typeof args.method === "string" ? args.method.toUpperCase() : undefined;

    if (!path || !method) {
      throw new McpError(ErrorCode.InvalidParams, "path and method are required");
    }

    if (!["GET", "POST", "PUT", "PATCH", "DELETE"].includes(method)) {
      throw new McpError(ErrorCode.InvalidParams, "Invalid method");
    }
    const genericUrl = new URL(path, `${config.baseUrl}/`);
    if (
      genericUrl.origin !== new URL(config.baseUrl).origin ||
      !genericUrl.pathname.startsWith("/api/")
    ) {
      throw new McpError(ErrorCode.InvalidParams, "path must start with /api/");
    }

    const result = await armRequest({
      config,
      path,
      method: method as HttpMethod,
      query: asJsonObject(args.query, "query"),
      body: asJsonObject(args.body, "body"),
      extraHeaders: asJsonObject(args.headers, "headers"),
      retryable: method === "GET",
    });

    return formatToolResult(result);
  }

  throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${toolName}`);
});

server.setRequestHandler(ListResourcesRequestSchema, async () => {
  return {
    resources: [
      {
        uri: "arm://docs/overview",
        name: "ARM MCP Overview",
        description: "Current ARM API tool mappings and utilities",
        mimeType: "application/json",
      },
      {
        uri: "arm://docs/cijobs-v1",
        name: "ARM CIJobs v1 APIs",
        description: "Modeled APIs from /api/cijobs/v1",
        mimeType: "application/json",
      },
      {
        uri: "arm://docs/ncino-cijobs-v1",
        name: "ARM nCino CI Jobs v1 APIs",
        description: "Modeled nCino CI job APIs from /api/cijobs/v1/ncino",
        mimeType: "application/json",
      },
      {
        uri: "arm://docs/deployments-v1",
        name: "ARM Deployments v1 APIs",
        description: "Modeled deployment reporting APIs from /api/deployments/v1",
        mimeType: "application/json",
      },
      {
        uri: "arm://docs/auth",
        name: "ARM Auth Guide",
        description: "Required environment variables and request headers",
        mimeType: "text/markdown",
      },
      {
        uri: "arm://docs/audit-logs",
        name: "ARM SIEM Audit Logs",
        description: "Audit log retrieval APIs, event types, and CEF response format",
        mimeType: "application/json",
      },
    ],
  };
});

server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
  const { uri } = request.params;

  if (uri === "arm://docs/overview") {
    return {
      contents: [
        {
          uri,
          mimeType: "application/json",
          text: JSON.stringify(
            {
              server: "arm-mcp-server",
              version: "0.5.0",
              capabilities: ["tools", "resources", "prompts"],
              modeledApis: {
                ciJobs: [
                  "GET /api/cijobs/v1/listcijobs",
                  "GET /api/cijobs/v1/history/{ciJobName}",
                  "GET /api/cijobs/v1/latestresults/{ciJobName}",
                  "GET /api/cijobs/v1/pollstatus/{ciJobName}/{buildNumber?}",
                  "GET /api/cijobs/v1/rollback/history/{ciJobName}/{buildNumber?}",
                  "GET /api/cijobs/v1/rollback/{ciJobName}",
                  "POST /api/cijobs/v1/trigger",
                  "POST /api/cijobs/v1/update/baselinerevision",
                  "POST /api/cijobs/v1/triggerquickdeploy/{ciJobName}/{buildNumber?}",
                  "POST /api/cijobs/v1/rollback",
                  "PUT /api/cijobs/v1/abort/{ciJobName}/{buildNumber?}",
                ],
                ncinoCiJobs: [
                  "GET /api/cijobs/v1/ncino/getalljobs",
                  "GET /api/cijobs/v1/ncino/gethistory",
                  "POST /api/cijobs/v1/ncino/trigger",
                  "POST /api/cijobs/v1/ncino/getcijobsummary",
                  "POST /api/cijobs/v1/ncino/getcijobinfo",
                  "POST /api/cijobs/v1/ncino/getcijobbuildhistory",
                  "POST /api/cijobs/v1/ncino/pollstatus",
                ],
                auditLogs: [
                  "GET /logs/audit_logs",
                  "GET /logs/audit_logs/download",
                ],
                deployments: [
                  "GET /api/deployments/v1/list",
                  "GET /api/deployments/v1/{label}",
                  "GET /api/deployments/v1/{label}/components",
                  "GET /api/deployments/v1/{label}/stories",
                  "GET /api/deployments/v1/{label}/logs/{iterationNumber}",
                  "GET /api/deployments/v1/{label}/coverage/{iterationNumber}",
                ],
              },
              utilityFeatures: [
                "CI Jobs, nCino CI Jobs, and Deployments: token header auth (ARM_API_TOKEN)",
                "Audit Logs: Bearer token auth (ARM_AUDIT_API_TOKEN)",
                "Base URL normalization with implicit https",
                "Bounded timeouts and status-aware retries for read operations",
                "Structured JSON response wrapping",
                "Optional generic /api endpoint tool, disabled by default",
              ],
            },
            null,
            2,
          ),
        },
      ],
    };
  }

  if (uri === "arm://docs/cijobs-v1") {
    return {
      contents: [
        {
          uri,
          mimeType: "application/json",
          text: JSON.stringify(
            [
              {
                tool: "arm_list_ci_jobs",
                method: "GET",
                path: "/api/cijobs/v1/listcijobs",
              },
              {
                tool: "arm_ci_job_history",
                method: "GET",
                path: "/api/cijobs/v1/history/{ciJobName}",
                query: ["from", "to"],
              },
              {
                tool: "arm_latest_results",
                method: "GET",
                path: "/api/cijobs/v1/latestresults/{ciJobName}",
              },
              {
                tool: "arm_poll_job_status",
                method: "GET",
                path: "/api/cijobs/v1/pollstatus/{ciJobName}/{buildNumber?}",
              },
              {
                tool: "arm_rollback_history",
                method: "GET",
                path: "/api/cijobs/v1/rollback/history/{ciJobName}/{buildNumber?}",
              },
              {
                tool: "arm_rollback_details",
                method: "GET",
                path: "/api/cijobs/v1/rollback/{ciJobName}",
              },
              {
                tool: "arm_trigger_build",
                method: "POST",
                path: "/api/cijobs/v1/trigger",
                body: ["projectName", "title"],
              },
              {
                tool: "arm_update_baseline_revision",
                method: "POST",
                path: "/api/cijobs/v1/update/baselinerevision",
                body: ["projectName", "baseLineRevision"],
              },
              {
                tool: "arm_quick_deploy",
                method: "POST",
                path: "/api/cijobs/v1/triggerquickdeploy/{ciJobName}/{buildNumber?}",
                body: ["projectName", "title"],
              },
              {
                tool: "arm_start_rollback",
                method: "POST",
                path: "/api/cijobs/v1/rollback",
                body: ["projectName", "title"],
              },
              {
                tool: "arm_abort_ci_job",
                method: "PUT",
                path: "/api/cijobs/v1/abort/{ciJobName}/{buildNumber?}",
                body: ["projectName", "title"],
              },
            ],
            null,
            2,
          ),
        },
      ],
    };
  }

  if (uri === "arm://docs/ncino-cijobs-v1") {
    return {
      contents: [
        {
          uri,
          mimeType: "application/json",
          text: JSON.stringify(
            {
              description: "AutoRABIT nCino CI Jobs Developer APIs",
              basePath: NCINO_CI_BASE_PATH,
              auth: "token: <ARM_API_TOKEN>",
              sourceReferences: [
                "https://knowledgebase.autorabit.com/product-guides/arm/arm-features/ncino/developer-apis/api-references",
                "https://documenter.getpostman.com/view/35959276/2sA3QwdAaS",
              ],
              contractNotes: [
                "Tool paths use the executable request URLs in the linked Postman collection.",
                "Published knowledge-base labels such as getAllProjects and triggerBuild differ from the executable paths getalljobs and trigger.",
                "The build-summary tool uses /api/cijobs/v1/ncino/getcijobsummary, matching the captured Postman request and the common nCino API base path.",
                "jobName values are case-sensitive.",
              ],
              endpoints: [
                {
                  tool: "arm_ncino_list_ci_jobs",
                  method: "GET",
                  path: "/api/cijobs/v1/ncino/getalljobs",
                  responseFields: [
                    "orgName",
                    "name",
                    "destinationorg",
                    "createdBy",
                    "autoCommit",
                    "repoName",
                    "branchName",
                    "jobType",
                  ],
                },
                {
                  tool: "arm_ncino_list_job_history",
                  method: "GET",
                  path: "/api/cijobs/v1/ncino/gethistory",
                  responseFields: [
                    "orgName",
                    "projectName",
                    "buildNumber",
                    "triggeredBy",
                    "buildStatus",
                    "deployStatus",
                    "overAllStatus",
                    "jobType",
                    "rollbackEnabled",
                  ],
                },
                {
                  tool: "arm_ncino_trigger_build",
                  method: "POST",
                  path: "/api/cijobs/v1/ncino/trigger",
                  body: {
                    jobName: "string",
                    jobHistory: [
                      "title",
                      "deploy",
                      "commitFeature",
                      "note",
                      "comment",
                      "rollbackEnabled",
                      "deployedSFOrg",
                      "projectType",
                    ],
                  },
                  responseFields: ["status", "result"],
                },
                {
                  tool: "arm_ncino_get_build_summary",
                  method: "POST",
                  path: "/api/cijobs/v1/ncino/getcijobsummary",
                  body: ["jobName", "nextPage"],
                  responseFields: ["ciJobHistoryList"],
                },
                {
                  tool: "arm_ncino_get_latest_build",
                  method: "POST",
                  path: "/api/cijobs/v1/ncino/getcijobinfo",
                  body: ["jobName"],
                  responseFields: [
                    "orgName",
                    "projectName",
                    "buildNumber",
                    "buildStatus",
                    "deployStatus",
                    "overAllStatus",
                    "postDeployStatus",
                    "rollbackEnabled",
                  ],
                },
                {
                  tool: "arm_ncino_get_build_history",
                  method: "POST",
                  path: "/api/cijobs/v1/ncino/getcijobbuildhistory",
                  body: ["jobName", "buildNumber"],
                  responseFields: [
                    "featureName",
                    "version",
                    "buildStatus",
                    "deployStatus",
                    "metadataRetrievalStatus",
                    "dataRetrievalStatus",
                    "dataRetrieved",
                  ],
                },
                {
                  tool: "arm_ncino_poll_build_status",
                  method: "POST",
                  path: "/api/cijobs/v1/ncino/pollstatus",
                  body: ["jobName", "buildNumber"],
                  responseFields: [
                    "projectName",
                    "buildNumber",
                    "buildStatus",
                    "deployStatus",
                    "status",
                    "validateRollBack",
                    "postDeployStatus",
                    "rollbackEnabled",
                  ],
                },
              ],
            },
            null,
            2,
          ),
        },
      ],
    };
  }

  if (uri === "arm://docs/deployments-v1") {
    return {
      contents: [
        {
          uri,
          mimeType: "application/json",
          text: JSON.stringify(
            [
              {
                tool: "arm_list_deployments",
                method: "GET",
                path: "/api/deployments/v1/list",
                query: ["status", "fromDate", "toDate", "labelName", "destSfOrg", "limit"],
                validStatuses: DEPLOYMENT_STATUSES,
                maxLimit: 100,
              },
              {
                tool: "arm_get_deployment",
                method: "GET",
                path: "/api/deployments/v1/{label}",
                pathParams: ["label"],
              },
              {
                tool: "arm_get_deployment_components",
                method: "GET",
                path: "/api/deployments/v1/{label}/components",
                pathParams: ["label"],
              },
              {
                tool: "arm_get_deployment_stories",
                method: "GET",
                path: "/api/deployments/v1/{label}/stories",
                pathParams: ["label"],
                query: ["iterationNumber"],
              },
              {
                tool: "arm_get_deployment_promotion_log",
                method: "GET",
                path: "/api/deployments/v1/{label}/logs/{iterationNumber}",
                pathParams: ["label", "iterationNumber"],
                responseFormat: "Plain text promotion log",
              },
              {
                tool: "arm_get_deployment_test_coverage",
                method: "GET",
                path: "/api/deployments/v1/{label}/coverage/{iterationNumber}",
                pathParams: ["label", "iterationNumber"],
                responseFormat: "JSON test coverage report",
              },
            ],
            null,
            2,
          ),
        },
      ],
    };
  }

  if (uri === "arm://docs/auth") {
    return {
      contents: [
        {
          uri,
          mimeType: "text/markdown",
          text: [
            "# ARM Auth",
            "",
            "## CI Jobs, nCino CI Jobs, and Deployment APIs",
            "",
            "Set these environment variables before starting the MCP server:",
            "",
            "- `ARM_BASE_URL`: Your ARM org URL (for example `pilot.autorabit.com` or `https://pilot.autorabit.com`)",
            "- `ARM_API_TOKEN`: API token sent as `token` header",
            "- `ARM_TIMEOUT_MS` (optional): request timeout in milliseconds, default `30000`",
            "- `ARM_MAX_RETRIES` (optional): retry count for network failures, default `2`",
            "- `ARM_ENABLE_GENERIC_TOOL` (optional): expose `arm_call_api`, default `false`",
            "- `ARM_ALLOW_INSECURE_HTTP` (optional): permit non-loopback HTTP base URLs, default `false`",
            "",
            "nCino tools call `/api/cijobs/v1/ncino/...`; deployment reporting tools call `/api/deployments/v1/...`. Both share the same `token` header auth.",
            "",
            "Default headers sent:",
            "- `token: <ARM_API_TOKEN>`",
            "- `Accept: application/json`",
            "- `Content-Type: application/json` when body exists",
            "",
            "## SIEM Audit Logs API",
            "",
            "The audit logs API uses a **separate** base URL and Bearer token (not shared with CI Jobs):",
            "",
            "- `ARM_AUDIT_BASE_URL`: Audit logs domain (for example `auditlogs.autorabit.com`)",
            "- `ARM_AUDIT_API_TOKEN`: Bearer token sent as `Authorization: Bearer <token>` header",
            "- `ARM_AUDIT_TIMEOUT_MS` (optional): request timeout in milliseconds, default `30000`",
            "- `ARM_AUDIT_MAX_RETRIES` (optional): retry count for network failures, default `2`",
            "- `ARM_AUDIT_DOWNLOAD_DIR` (optional): local directory for downloaded ZIP files",
            "- `ARM_AUDIT_MAX_DOWNLOAD_BYTES` (optional): maximum ZIP size, default `52428800`",
            "",
            "Default headers sent:",
            "- `Authorization: Bearer <ARM_AUDIT_API_TOKEN>`",
            "- `Accept: application/json` or `application/zip`",
          ].join("\n"),
        },
      ],
    };
  }

  if (uri === "arm://docs/audit-logs") {
    return {
      contents: [
        {
          uri,
          mimeType: "application/json",
          text: JSON.stringify(
            {
              description: "AutoRABIT SIEM Audit Logs Retrieval API",
              baseUrl: "https://<prefix>auditlogs.autorabit.com",
              auth: "Authorization: Bearer <ARM_AUDIT_API_TOKEN>",
              endpoints: [
                {
                  tool: "arm_audit_get_logs",
                  method: "GET",
                  path: "/logs/audit_logs",
                  query: ["startTime", "maxResults", "eventType"],
                  responseFormat: "Array of CEF (Common Event Format) strings",
                },
                {
                  tool: "arm_audit_download_logs",
                  method: "GET",
                  path: "/logs/audit_logs/download",
                  query: ["startTime", "endTime"],
                  responseFormat:
                    "Bounded local ZIP file plus MCP resource link (max 90-day range)",
                },
              ],
              eventTypes: AUDIT_EVENT_TYPES,
              cefFormat: "timestamp CEF:version|vendor|product|productVersion|eventType|name|severity|extensions",
            },
            null,
            2,
          ),
        },
      ],
    };
  }

  throw new McpError(ErrorCode.InvalidRequest, `Unknown resource URI: ${uri}`);
});

server.setRequestHandler(ListPromptsRequestSchema, async () => {
  return {
    prompts: [
      {
        name: "arm_quick_deploy_guide",
        description: "Guide the model to execute quick deploy via ARM CI Jobs APIs",
        arguments: [
          {
            name: "ci_job_name",
            required: true,
            description: "Case-sensitive CI job name",
          },
          {
            name: "project_name",
            required: true,
            description: "Case-sensitive CI project name",
          },
          {
            name: "title",
            required: true,
            description: "Build label",
          },
          {
            name: "build_number",
            required: false,
            description: "Optional build number",
          },
        ],
      },
      {
        name: "arm_rollback_guide",
        description: "Guide the model to decide and execute rollback via ARM APIs",
        arguments: [
          {
            name: "project_name",
            required: true,
            description: "Case-sensitive CI project name",
          },
          {
            name: "title",
            required: true,
            description: "Build label",
          },
        ],
      },
      {
        name: "arm_trigger_build_guide",
        description: "Guide the model to trigger a new CI build and monitor its progress",
        arguments: [
          {
            name: "ci_job_name",
            required: true,
            description: "Case-sensitive CI job name used to poll the triggered build",
          },
          {
            name: "project_name",
            required: true,
            description: "Case-sensitive CI project name",
          },
          {
            name: "title",
            required: true,
            description: "Build label",
          },
        ],
      },
      {
        name: "arm_poll_status_guide",
        description: "Guide the model to poll CI job status and interpret the results",
        arguments: [
          {
            name: "ci_job_name",
            required: true,
            description: "Case-sensitive CI job name",
          },
          {
            name: "build_number",
            required: false,
            description: "Optional build number to poll",
          },
        ],
      },
      {
        name: "arm_audit_logs_guide",
        description:
          "Guide the model to query and analyze SIEM audit logs from AutoRABIT ARM",
        arguments: [
          {
            name: "event_types",
            required: false,
            description:
              "Comma-separated event types (e.g. LOGIN,DEPLOYMENT). Use arm_audit_list_event_types to discover valid values.",
          },
          {
            name: "start_time",
            required: false,
            description: "Start time in ISO 8601 format (YYYY-MM-DDThh:mm:ss)",
          },
          {
            name: "max_results",
            required: false,
            description: "Maximum number of log entries to retrieve (default 1000)",
          },
        ],
      },
      {
        name: "arm_deployment_report_guide",
        description:
          "Guide the model to collect deployment detail, components, Jira stories, logs, and test coverage for a deployment report",
        arguments: [
          {
            name: "label",
            required: true,
            description: "Deployment label name",
          },
          {
            name: "iteration_number",
            required: false,
            description: "Deployment iteration number for logs and coverage. Use latestIterationNumber from detail if omitted.",
          },
        ],
      },
      {
        name: "arm_ncino_build_and_monitor_guide",
        description:
          "Guide the model to validate an nCino CI job, trigger a build with explicit behavior, and monitor the resulting build",
        arguments: [
          {
            name: "job_name",
            required: true,
            description: "Case-sensitive nCino CI job name",
          },
          {
            name: "title",
            required: true,
            description: "Build label",
          },
          {
            name: "deploy",
            required: true,
            description: "Whether the build should deploy: true or false",
          },
          {
            name: "commit_feature",
            required: true,
            description: "Whether the build should commit the feature: true or false",
          },
          {
            name: "destination_org",
            required: false,
            description: "Optional destination Salesforce org name",
          },
        ],
      },
      {
        name: "arm_ncino_build_report_guide",
        description:
          "Guide the model to collect and interpret nCino CI build summary, status, and feature-level history",
        arguments: [
          {
            name: "job_name",
            required: true,
            description: "Case-sensitive nCino CI job name",
          },
          {
            name: "build_number",
            required: false,
            description: "Optional build number. The latest build is used when omitted.",
          },
        ],
      },
    ],
  };
});

server.setRequestHandler(GetPromptRequestSchema, async (request) => {
  const { name, arguments: args = {} } = request.params;

  if (name === "arm_quick_deploy_guide") {
    const ciJobName = typeof args.ci_job_name === "string" ? args.ci_job_name : "<ci_job_name>";
    const projectName = typeof args.project_name === "string" ? args.project_name : "<project_name>";
    const title = typeof args.title === "string" ? args.title : "<title>";
    const buildNumber = typeof args.build_number === "string" ? args.build_number : "<optional_build_number>";

    return {
      description: "Quick deploy execution flow",
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: [
              "Execute quick deploy for this ARM CI job:",
              `- ci_job_name: ${ciJobName}`,
              `- project_name: ${projectName}`,
              `- title: ${title}`,
              `- build_number: ${buildNumber}`,
              "",
              "Use tool `arm_quick_deploy` and summarize:",
              "- HTTP status",
              "- deployment initiation message",
              "- rollback validation flag",
            ].join("\n"),
          },
        },
      ],
    };
  }

  if (name === "arm_rollback_guide") {
    const projectName = typeof args.project_name === "string" ? args.project_name : "<project_name>";
    const title = typeof args.title === "string" ? args.title : "<title>";

    return {
      description: "Rollback decision and execution flow",
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: [
              "Attempt rollback for this ARM CI job payload:",
              `- project_name: ${projectName}`,
              `- title: ${title}`,
              "",
              "Call `arm_start_rollback` and classify result as:",
              "- rollback initiated",
              "- not eligible",
              "- unknown",
              "",
              "Then provide next action recommendation.",
            ].join("\n"),
          },
        },
      ],
    };
  }

  if (name === "arm_trigger_build_guide") {
    const ciJobName = typeof args.ci_job_name === "string" ? args.ci_job_name : "<ci_job_name>";
    const projectName = typeof args.project_name === "string" ? args.project_name : "<project_name>";
    const title = typeof args.title === "string" ? args.title : "<title>";

    return {
      description: "Trigger build and monitor execution flow",
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: [
              "Trigger a new CI build for this ARM CI job:",
              `- ci_job_name: ${ciJobName}`,
              `- project_name: ${projectName}`,
              `- title: ${title}`,
              "",
              "Steps:",
              "1. Call `arm_trigger_build` with the above payload",
              "2. Note the returned build number (cyclenum)",
              "3. Call `arm_poll_job_status` with ciJobName and the returned build number",
              "4. Summarize: build number, current status, and whether rollback is validated",
            ].join("\n"),
          },
        },
      ],
    };
  }

  if (name === "arm_poll_status_guide") {
    const ciJobName = typeof args.ci_job_name === "string" ? args.ci_job_name : "<ci_job_name>";
    const buildNumber = typeof args.build_number === "string" ? args.build_number : "<optional_build_number>";

    return {
      description: "Poll job status and interpret results",
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: [
              "Poll the status of this ARM CI job build:",
              `- ci_job_name: ${ciJobName}`,
              `- build_number: ${buildNumber}`,
              "",
              "Call `arm_poll_job_status` and classify the result as:",
              "- Completed successfully",
              "- In progress",
              "- Failed",
              "",
              "Report: build status, quick deploy status, rollback validation flag.",
              "If in progress, suggest polling again after a short delay.",
            ].join("\n"),
          },
        },
      ],
    };
  }

  if (name === "arm_audit_logs_guide") {
    const eventTypes =
      typeof args.event_types === "string" ? args.event_types : "<optional_event_types>";
    const startTime =
      typeof args.start_time === "string" ? args.start_time : "<optional_start_time>";
    const maxResults =
      typeof args.max_results === "string" ? args.max_results : "1000";

    return {
      description: "Audit log query and analysis flow",
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: [
              "Query and analyze SIEM audit logs from AutoRABIT ARM.",
              "",
              "Parameters:",
              `- event_types: ${eventTypes}`,
              `- start_time: ${startTime}`,
              `- max_results: ${maxResults}`,
              "",
              "Steps:",
              "1. Call `arm_audit_list_event_types` to review available event types and their modules",
              "2. Call `arm_audit_get_logs` with the specified filters (startTime, maxResults, eventType)",
              "3. Parse the CEF-formatted log entries — each line follows: timestamp CEF:version|vendor|product|productVersion|eventType|name|severity|extensions",
              "4. Summarize findings:",
              "   - Total number of log entries returned",
              "   - Breakdown by event type",
              "   - Notable patterns (failed logins, deployment activity, recent commits/merges)",
              "   - Any anomalies or security concerns",
              "5. If relevant, suggest narrower queries for deeper investigation",
            ].join("\n"),
          },
        },
      ],
    };
  }

  if (name === "arm_deployment_report_guide") {
    const label = typeof args.label === "string" ? args.label : "<deployment_label>";
    const iterationNumber =
      typeof args.iteration_number === "string" ? args.iteration_number : "<latest_iteration_number>";

    return {
      description: "Deployment reporting and traceability flow",
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: [
              "Generate a deployment report for this ARM deployment:",
              `- label: ${label}`,
              `- iteration_number: ${iterationNumber}`,
              "",
              "Steps:",
              "1. Call `arm_get_deployment` for summary details and latest iteration metadata",
              "2. Call `arm_get_deployment_components` for component changes",
              "3. Call `arm_get_deployment_stories` for Jira-linked commit traceability",
              "4. Call `arm_get_deployment_promotion_log` for the selected iteration",
              "5. Call `arm_get_deployment_test_coverage` for the selected iteration",
              "",
              "Summarize: deployment status, source and target environments, triggering user, changed components by type and change type, Jira stories with commits, notable log diagnostics, and test coverage pass/fail counts.",
              "If iteration_number is omitted, use the latestIterationNumber from `arm_get_deployment` for logs and coverage.",
            ].join("\n"),
          },
        },
      ],
    };
  }

  if (name === "arm_ncino_build_and_monitor_guide") {
    const jobName = typeof args.job_name === "string" ? args.job_name : "<job_name>";
    const title = typeof args.title === "string" ? args.title : "<title>";
    const deploy = typeof args.deploy === "string" ? args.deploy : "<true_or_false>";
    const commitFeature =
      typeof args.commit_feature === "string" ? args.commit_feature : "<true_or_false>";
    const destinationOrg =
      typeof args.destination_org === "string" ? args.destination_org : "<optional_destination_org>";

    return {
      description: "nCino CI build execution and monitoring flow",
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: [
              "Execute and monitor this nCino CI build:",
              `- job_name: ${jobName}`,
              `- title: ${title}`,
              `- deploy: ${deploy}`,
              `- commit_feature: ${commitFeature}`,
              `- destination_org: ${destinationOrg}`,
              "",
              "Steps:",
              "1. Call `arm_ncino_list_ci_jobs` and require one exact, case-sensitive match for job_name.",
              "2. Call `arm_ncino_trigger_build` with the supplied jobName, title, deploy, commitFeature, and destination org. Pass deploy and commitFeature as JSON booleans.",
              "3. Call `arm_ncino_get_latest_build` to obtain the resulting buildNumber. If the previous build is still returned, retry this lookup at most twice.",
              "4. Call `arm_ncino_poll_build_status` for that jobName and buildNumber.",
              "5. When the status is terminal, call `arm_ncino_get_build_history` for feature-level outcomes.",
              "",
              "Report the trigger result, build number, build status, deployment status, post-deployment status, rollback flags, and failed feature/version entries. Keep each ARM status field separate when they disagree.",
            ].join("\n"),
          },
        },
      ],
    };
  }

  if (name === "arm_ncino_build_report_guide") {
    const jobName = typeof args.job_name === "string" ? args.job_name : "<job_name>";
    const buildNumber =
      typeof args.build_number === "string" ? args.build_number : "<latest_build_number>";

    return {
      description: "nCino CI build investigation and reporting flow",
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: [
              "Generate an nCino CI build report:",
              `- job_name: ${jobName}`,
              `- build_number: ${buildNumber}`,
              "",
              "Steps:",
              "1. Call `arm_ncino_list_ci_jobs` and verify the exact, case-sensitive job name.",
              "2. Call `arm_ncino_get_latest_build`; use its buildNumber when no build number was supplied.",
              "3. Call `arm_ncino_get_build_summary` for recent build context.",
              "4. Call `arm_ncino_poll_build_status` for the selected build.",
              "5. Call `arm_ncino_get_build_history` for feature, version, metadata retrieval, data retrieval, build, and deployment outcomes.",
              "",
              "Summarize the selected build, trigger identity, timestamps, destination org, each independent status field, rollback eligibility, and feature-level failures. State missing fields as unavailable; do not infer success from an empty field.",
            ].join("\n"),
          },
        },
      ],
    };
  }

  throw new McpError(ErrorCode.InvalidRequest, `Unknown prompt: ${name}`);
});

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((error) => {
  console.error("Failed to start ARM MCP server:", error);
  process.exit(1);
});
