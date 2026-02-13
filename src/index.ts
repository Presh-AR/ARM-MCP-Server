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

function normalizeBaseUrl(raw: string): string {
  const trimmed = raw.trim().replace(/\/$/, "");
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  return `https://${trimmed}`;
}

function getConfig(): ArmConfig {
  const baseUrl = process.env.ARM_BASE_URL?.trim();
  const apiToken = process.env.ARM_API_TOKEN?.trim();
  const timeoutMs = Number(process.env.ARM_TIMEOUT_MS ?? "30000");
  const maxRetries = Number(process.env.ARM_MAX_RETRIES ?? "2");

  if (!baseUrl) {
    throw new McpError(ErrorCode.InvalidRequest, "Missing ARM_BASE_URL environment variable");
  }

  if (!apiToken) {
    throw new McpError(ErrorCode.InvalidRequest, "Missing ARM_API_TOKEN environment variable");
  }

  return {
    baseUrl: normalizeBaseUrl(baseUrl),
    apiToken,
    timeoutMs: Number.isFinite(timeoutMs) ? timeoutMs : 30000,
    maxRetries: Number.isFinite(maxRetries) ? maxRetries : 2,
  };
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

function buildUrl(baseUrl: string, path: string, query?: JsonObject): string {
  const url = new URL(path, `${baseUrl}/`);
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

async function armRequest(args: {
  config: ArmConfig;
  path: string;
  method: HttpMethod;
  query?: JsonObject;
  body?: JsonObject;
  extraHeaders?: JsonObject;
}): Promise<{ status: number; data: unknown; headers: Record<string, string> }> {
  const { config, path, method, query, body, extraHeaders } = args;
  const url = buildUrl(config.baseUrl, path, query);

  const headers: Record<string, string> = {
    Accept: "application/json",
    token: config.apiToken,
  };

  if (body !== undefined) {
    headers["Content-Type"] = "application/json";
  }

  if (extraHeaders) {
    for (const [k, v] of Object.entries(extraHeaders)) {
      if (v === undefined || v === null) continue;
      headers[k] = String(v);
    }
  }

  let attempt = 0;
  let lastError: unknown;

  while (attempt <= config.maxRetries) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), config.timeoutMs);

    try {
      const response = await fetch(url, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      });

      clearTimeout(timeout);

      const data = await parseResponseBody(response);
      const responseHeaders: Record<string, string> = {};
      response.headers.forEach((value, key) => {
        responseHeaders[key] = value;
      });

      return {
        status: response.status,
        data,
        headers: responseHeaders,
      };
    } catch (error) {
      clearTimeout(timeout);
      lastError = error;
      attempt += 1;

      if (attempt > config.maxRetries) {
        break;
      }

      await new Promise((resolve) => setTimeout(resolve, attempt * 300));
    }
  }

  throw new McpError(
    ErrorCode.InternalError,
    `ARM request failed after ${config.maxRetries + 1} attempts: ${String(lastError)}`,
  );
}

function formatToolResult(result: unknown): { content: Array<{ type: "text"; text: string }> } {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(result, null, 2),
      },
    ],
  };
}

const server = new Server(
  {
    name: "arm-mcp-server",
    version: "0.2.0",
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
  return {
    tools: [
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
              type: "number",
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
              type: "number",
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
        name: "arm_call_api",
        description:
          "Generic ARM API request tool for additional endpoints not yet modeled as dedicated tools.",
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
    ],
  };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const config = getConfig();
  const toolName = request.params.name;
  const args = request.params.arguments ?? {};

  if (toolName === "arm_quick_deploy") {
    const ciJobName = encodeURIComponent(getStringArg(args.ciJobName, "ciJobName")!);
    const buildNumberRaw = args.buildNumber;
    const buildSegment =
      typeof buildNumberRaw === "number" && Number.isFinite(buildNumberRaw)
        ? `/${String(buildNumberRaw)}`
        : "";

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
    const buildNumberRaw = args.buildNumber;
    const buildSegment =
      typeof buildNumberRaw === "number" && Number.isFinite(buildNumberRaw)
        ? `/${String(buildNumberRaw)}`
        : "";

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

  if (toolName === "arm_call_api") {
    const path = typeof args.path === "string" ? args.path : undefined;
    const method = typeof args.method === "string" ? args.method.toUpperCase() : undefined;

    if (!path || !method) {
      throw new McpError(ErrorCode.InvalidParams, "path and method are required");
    }

    if (!["GET", "POST", "PUT", "PATCH", "DELETE"].includes(method)) {
      throw new McpError(ErrorCode.InvalidParams, "Invalid method");
    }

    const result = await armRequest({
      config,
      path,
      method: method as HttpMethod,
      query: asJsonObject(args.query, "query"),
      body: asJsonObject(args.body, "body"),
      extraHeaders: asJsonObject(args.headers, "headers"),
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
        uri: "arm://docs/auth",
        name: "ARM Auth Guide",
        description: "Required environment variables and request headers",
        mimeType: "text/markdown",
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
              version: "0.2.0",
              capabilities: ["tools", "resources", "prompts"],
              modeledApis: [
                "POST /api/cijobs/v1/triggerquickdeploy/{ciJobName}/{buildNumber?}",
                "POST /api/cijobs/v1/rollback",
                "PUT /api/cijobs/v1/abort/{ciJobName}/{buildNumber?}",
              ],
              utilityFeatures: [
                "token header auth",
                "Base URL normalization with implicit https",
                "Timeout + retries",
                "Structured JSON response wrapping",
                "Generic endpoint tool",
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

  if (uri === "arm://docs/auth") {
    return {
      contents: [
        {
          uri,
          mimeType: "text/markdown",
          text: [
            "# ARM Auth",
            "",
            "Set these environment variables before starting the MCP server:",
            "",
            "- `ARM_BASE_URL`: Your ARM org URL (for example `pilot.autorabit.com` or `https://pilot.autorabit.com`)",
            "- `ARM_API_TOKEN`: API token sent as `token` header",
            "- `ARM_TIMEOUT_MS` (optional): request timeout in milliseconds, default `30000`",
            "- `ARM_MAX_RETRIES` (optional): retry count for network failures, default `2`",
            "",
            "Default headers sent:",
            "- `token: <ARM_API_TOKEN>`",
            "- `Accept: application/json`",
            "- `Content-Type: application/json` when body exists",
          ].join("\n"),
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
