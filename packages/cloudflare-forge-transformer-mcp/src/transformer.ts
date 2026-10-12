/**
 * MCP server transformer for Forge.
 *
 * Turns an OpenAPI document into a runnable Model Context Protocol server:
 * one MCP tool per operation, served over stdio, calling the API over HTTP.
 *
 * v1 scope (deliberate):
 * - JSON request/response bodies only. Operations with form-encoded or
 *   multipart request bodies, streaming (SSE) responses, or binary
 *   responses are skipped and reported, never silently dropped.
 * - Auth comes from the environment, never from tool arguments:
 *   `<PREFIX>_BASE_URL`, `<PREFIX>_API_TOKEN` (bearer), and one env var
 *   per apiKey header security scheme (e.g. `<PREFIX>_X_CUSTOM_HEADER`).
 * - Non-security header parameters are ordinary tool arguments.
 */

import type { Forge, TransformerFn } from '@cloudflare/forge';
import type { OpenAPIV3 } from 'openapi-types';

export interface McpTransformerOptions {
  /** Generated server/package name. Default: slug of the spec title + "-mcp-server". */
  serverName?: string | undefined;
  /** Generated server version. Default: the spec's info.version, else "0.1.0". */
  serverVersion?: string | undefined;
  /** Env var prefix. Default: UPPER_SNAKE of the server name. */
  envPrefix?: string | undefined;
}

export interface McpToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  method: string;
  path: string;
  pathParams: string[];
  queryParams: string[];
  headerParams: string[];
  hasBody: boolean;
}

export interface SkippedOperation {
  operationId: string;
  method: string;
  path: string;
  reason: string;
}

export interface McpGenerationPlan {
  serverName: string;
  serverVersion: string;
  envPrefix: string;
  baseUrlDefault?: string | undefined;
  bearerAuth: boolean;
  authHeaders: { header: string; env: string }[];
  tools: McpToolDef[];
  skipped: SkippedOperation[];
}

type JsonObject = Record<string, unknown>;

const HTTP_METHODS = ['get', 'post', 'put', 'patch', 'delete'] as const;

function isRecord(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function envify(value: string): string {
  return value
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

/**
 * Resolve local `#/...` $refs into a self-contained schema. Cycles and
 * unresolvable refs collapse to an empty schema so one bad branch cannot
 * take down the whole generation.
 */
export function derefSchema(doc: JsonObject, schema: unknown, seen: ReadonlySet<string> = new Set()): unknown {
  if (Array.isArray(schema)) {
    return schema.map((item) => derefSchema(doc, item, seen));
  }
  if (!isRecord(schema)) return schema;

  const ref = schema['$ref'];
  if (typeof ref === 'string' && ref.startsWith('#/')) {
    if (seen.has(ref)) return {};
    const target = ref
      .slice(2)
      .split('/')
      .reduce<unknown>(
        (node, key) => (isRecord(node) ? node[key.replace(/~1/g, '/').replace(/~0/g, '~')] : undefined),
        doc,
      );
    if (target === undefined) return {};
    const nextSeen = new Set(seen);
    nextSeen.add(ref);
    return derefSchema(doc, target, nextSeen);
  }

  return Object.fromEntries(Object.entries(schema).map(([key, value]) => [key, derefSchema(doc, value, seen)]));
}

function resolveRef(doc: JsonObject, value: unknown): unknown {
  if (!isRecord(value)) return value;
  const ref = value['$ref'];
  if (typeof ref !== 'string' || !ref.startsWith('#/')) return value;
  return ref
    .slice(2)
    .split('/')
    .reduce<unknown>(
      (node, key) => (isRecord(node) ? node[key.replace(/~1/g, '/').replace(/~0/g, '~')] : undefined),
      doc,
    );
}

function operationIdFallback(method: string, path: string): string {
  const slug = slugify(path.replace(/[{}]/g, ''));
  return `${method}_${slug}`.replace(/-([a-z0-9])/g, (_m, c: string) => c.toUpperCase());
}

function isJsonContentType(contentType: string): boolean {
  return contentType === 'application/json' || contentType.endsWith('+json');
}

/**
 * Build the generation plan (tool definitions + skip list) for a document.
 * Pure and synchronous so tests can assert on it without running a Forge
 * transform.
 */
export function buildMcpPlan(doc: OpenAPIV3.Document, options: McpTransformerOptions = {}): McpGenerationPlan {
  const raw = doc as unknown as JsonObject;
  const info = isRecord(raw['info']) ? raw['info'] : {};
  const title = typeof info['title'] === 'string' ? info['title'] : 'api';
  const serverName = options.serverName ?? `${slugify(title)}-mcp-server`;
  const serverVersion = options.serverVersion ?? (typeof info['version'] === 'string' ? info['version'] : '0.1.0');
  // Env var names cannot start with a digit in any shell, so a spec whose
  // name starts with one (e.g. "9router") gets an API_ lead-in.
  const derivedPrefix = envify(serverName.replace(/-mcp-server$/, ''));
  const envPrefix = options.envPrefix ?? (/^[0-9]/.test(derivedPrefix) ? `API_${derivedPrefix}` : derivedPrefix);

  const servers = Array.isArray(raw['servers']) ? raw['servers'] : [];
  const firstServer = isRecord(servers[0]) ? servers[0] : undefined;
  const baseUrlDefault = typeof firstServer?.['url'] === 'string' ? (firstServer['url'] as string) : undefined;

  // Security schemes: bearer token and apiKey headers are wired to env vars.
  const components = isRecord(raw['components']) ? raw['components'] : {};
  const schemes = isRecord(components['securitySchemes']) ? components['securitySchemes'] : {};
  let bearerAuth = false;
  const authHeaders: { header: string; env: string }[] = [];
  const authHeaderNames = new Set<string>();
  for (const schemeValue of Object.values(schemes)) {
    const scheme = resolveRef(raw, schemeValue);
    if (!isRecord(scheme)) continue;
    if (scheme['type'] === 'http' && scheme['scheme'] === 'bearer') bearerAuth = true;
    if (scheme['type'] === 'apiKey' && scheme['in'] === 'header' && typeof scheme['name'] === 'string') {
      authHeaderNames.add(scheme['name'] as string);
      authHeaders.push({ header: scheme['name'] as string, env: `${envPrefix}_${envify(scheme['name'] as string)}` });
    }
  }

  const tools: McpToolDef[] = [];
  const skipped: SkippedOperation[] = [];
  const paths = isRecord(raw['paths']) ? raw['paths'] : {};

  for (const path of Object.keys(paths).sort()) {
    const pathItem = resolveRef(raw, paths[path]);
    if (!isRecord(pathItem)) continue;
    const sharedParams = Array.isArray(pathItem['parameters']) ? pathItem['parameters'] : [];

    for (const method of HTTP_METHODS) {
      const operationValue = pathItem[method];
      if (!isRecord(operationValue)) continue;
      const operation = resolveRef(raw, operationValue);
      if (!isRecord(operation)) continue;

      const operationId =
        typeof operation['operationId'] === 'string' && operation['operationId']
          ? (operation['operationId'] as string)
          : operationIdFallback(method, path);
      const skip = (reason: string) => skipped.push({ operationId, method: method.toUpperCase(), path, reason });

      // Request body: JSON only in v1.
      const requestBodyValue = resolveRef(raw, operation['requestBody']);
      const requestBody = isRecord(requestBodyValue) ? requestBodyValue : undefined;
      let bodySchema: unknown;
      let hasBody = false;
      if (requestBody) {
        const content = isRecord(requestBody['content']) ? requestBody['content'] : {};
        const contentTypes = Object.keys(content);
        if (
          contentTypes.some((t) => t.includes('multipart/form-data') || t.includes('application/x-www-form-urlencoded'))
        ) {
          skip('form-encoded or multipart request bodies are not supported in v1');
          continue;
        }
        const jsonType = contentTypes.find(isJsonContentType);
        if (!jsonType) {
          skip('non-JSON request body is not supported in v1');
          continue;
        }
        const media = isRecord(content[jsonType]) ? content[jsonType] : {};
        bodySchema = derefSchema(raw, media['schema'] ?? {});
        hasBody = true;
      }

      // Responses: need JSON (or no content at all, e.g. 204) in v1.
      const responses = isRecord(operation['responses']) ? operation['responses'] : {};
      const successKeys = Object.keys(responses).filter((k) => /^2\d\d$/.test(k) || k === 'default');
      let responseSkip: string | undefined;
      for (const key of successKeys) {
        const response = resolveRef(raw, responses[key]);
        if (!isRecord(response)) continue;
        const content = isRecord(response['content']) ? response['content'] : {};
        const types = Object.keys(content);
        if (types.length === 0) continue;
        if (types.some(isJsonContentType)) continue;
        if (types.includes('text/event-stream')) {
          responseSkip = 'streaming (SSE) responses are not supported in v1';
        } else if (!types.some((t) => t.startsWith('text/'))) {
          responseSkip = 'binary (non-JSON) responses are not supported in v1';
        }
      }
      if (
        responseSkip &&
        !successKeys.some((k) => {
          const response = resolveRef(raw, responses[k]);
          const content = isRecord(response) && isRecord(response['content']) ? response['content'] : {};
          return Object.keys(content).some(isJsonContentType);
        })
      ) {
        skip(responseSkip);
        continue;
      }

      // Parameters -> flat tool arguments.
      const properties: JsonObject = {};
      const required: string[] = [];
      const pathParams: string[] = [];
      const queryParams: string[] = [];
      const headerParams: string[] = [];
      const allParams = [...sharedParams, ...(Array.isArray(operation['parameters']) ? operation['parameters'] : [])];
      for (const paramValue of allParams) {
        const param = resolveRef(raw, paramValue);
        if (!isRecord(param) || typeof param['name'] !== 'string' || typeof param['in'] !== 'string') continue;
        const name = param['name'] as string;
        if (param['in'] === 'header' && authHeaderNames.has(name)) continue; // auth: env, not an argument
        const schema = derefSchema(raw, param['schema'] ?? { type: 'string' });
        const prop: JsonObject = isRecord(schema) ? { ...schema } : { type: 'string' };
        if (typeof param['description'] === 'string' && prop['description'] === undefined) {
          prop['description'] = param['description'];
        }
        properties[name] = prop;
        if (param['required'] === true) required.push(name);
        if (param['in'] === 'path') pathParams.push(name);
        else if (param['in'] === 'query') queryParams.push(name);
        else if (param['in'] === 'header') headerParams.push(name);
      }
      if (hasBody) {
        properties['body'] = bodySchema as JsonObject;
        if (requestBody?.['required'] === true) required.push('body');
      }

      const description =
        (typeof operation['description'] === 'string' && operation['description']) ||
        (typeof operation['summary'] === 'string' && operation['summary']) ||
        `${method.toUpperCase()} ${path}`;

      tools.push({
        name: operationId,
        description: description.slice(0, 1000),
        inputSchema: {
          type: 'object',
          properties,
          ...(required.length > 0 ? { required } : {}),
          additionalProperties: false,
        },
        method: method.toUpperCase(),
        path,
        pathParams,
        queryParams,
        headerParams,
        hasBody,
      });
    }
  }

  const plan: McpGenerationPlan = { serverName, serverVersion, envPrefix, bearerAuth, authHeaders, tools, skipped };
  if (baseUrlDefault !== undefined) plan.baseUrlDefault = baseUrlDefault;
  return plan;
}

const SERVER_TEMPLATE = `// Generated by @cloudflare/forge-transformer-mcp — do not edit by hand.
// Regenerate from the OpenAPI spec instead.
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const CONFIG = __CONFIG_JSON__;
const TOOLS = __TOOLS_JSON__;

const baseUrl = (process.env[CONFIG.envPrefix + '_BASE_URL'] ?? CONFIG.baseUrlDefault ?? 'http://localhost').replace(/[/]+$/, '');

function buildHeaders(tool, args) {
  const headers = {};
  if (tool.hasBody) headers['content-type'] = 'application/json';
  if (CONFIG.bearerAuth) {
    const token = process.env[CONFIG.envPrefix + '_API_TOKEN'];
    if (token) headers['authorization'] = 'Bearer ' + token;
  }
  for (const auth of CONFIG.authHeaders) {
    const value = process.env[auth.env];
    if (value) headers[auth.header] = value;
  }
  for (const name of tool.headerParams) {
    if (args[name] !== undefined && args[name] !== null) headers[name] = String(args[name]);
  }
  return headers;
}

async function callTool(tool, args) {
  let path = tool.path;
  for (const name of tool.pathParams) {
    path = path.split('{' + name + '}').join(encodeURIComponent(String(args[name])));
  }
  const url = new URL(baseUrl + path);
  for (const name of tool.queryParams) {
    const value = args[name];
    if (value === undefined || value === null) continue;
    if (Array.isArray(value)) {
      for (const item of value) url.searchParams.append(name, String(item));
    } else {
      url.searchParams.set(name, String(value));
    }
  }
  let response;
  try {
    response = await fetch(url, {
      method: tool.method,
      headers: buildHeaders(tool, args),
      body: tool.hasBody ? JSON.stringify(args.body ?? {}) : undefined,
      signal: AbortSignal.timeout(60000),
    });
  } catch (error) {
    return { content: [{ type: 'text', text: 'request failed: ' + (error instanceof Error ? error.message : String(error)) }], isError: true };
  }
  const text = await response.text();
  let out = text;
  try {
    out = JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    // non-JSON body: return as-is
  }
  return { content: [{ type: 'text', text: out }], isError: !response.ok };
}

const server = new Server({ name: CONFIG.name, version: CONFIG.version }, { capabilities: { tools: {} } });

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: TOOLS.map((tool) => ({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema })),
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const tool = TOOLS.find((t) => t.name === request.params.name);
  if (!tool) {
    return { content: [{ type: 'text', text: 'unknown tool: ' + request.params.name }], isError: true };
  }
  return callTool(tool, request.params.arguments ?? {});
});

await server.connect(new StdioServerTransport());
`;

function renderServerJs(plan: McpGenerationPlan): string {
  const config = {
    name: plan.serverName,
    version: plan.serverVersion,
    envPrefix: plan.envPrefix,
    baseUrlDefault: plan.baseUrlDefault ?? null,
    bearerAuth: plan.bearerAuth,
    authHeaders: plan.authHeaders,
  };
  const tools = plan.tools.map(
    ({ name, description, inputSchema, method, path, pathParams, queryParams, headerParams, hasBody }) => ({
      name,
      description,
      inputSchema,
      method,
      path,
      pathParams,
      queryParams,
      headerParams,
      hasBody,
    }),
  );
  return SERVER_TEMPLATE.replace('__CONFIG_JSON__', JSON.stringify(config, null, 2)).replace(
    '__TOOLS_JSON__',
    JSON.stringify(tools, null, 2),
  );
}

function renderPackageJson(plan: McpGenerationPlan): string {
  return `${JSON.stringify(
    {
      name: plan.serverName,
      version: plan.serverVersion,
      description: `MCP server generated from an OpenAPI spec by @cloudflare/forge-transformer-mcp (${plan.tools.length} tools).`,
      license: 'Apache-2.0',
      type: 'module',
      main: 'server.js',
      scripts: { start: 'node server.js' },
      dependencies: { '@modelcontextprotocol/sdk': '^1.30.0' },
      engines: { node: '>=18' },
    },
    null,
    2,
  )}\n`;
}

function renderReadme(plan: McpGenerationPlan): string {
  const lines: string[] = [
    `# ${plan.serverName}`,
    '',
    'MCP server generated by `@cloudflare/forge-transformer-mcp` from an OpenAPI spec.',
    'One tool per API operation, served over stdio.',
    '',
    '## Run',
    '',
    '```sh',
    'npm install',
    'node server.js',
    '```',
    '',
    '## Configuration (environment)',
    '',
    `- \`${plan.envPrefix}_BASE_URL\` — API base URL (default: ${plan.baseUrlDefault ?? 'http://localhost'})`,
  ];
  if (plan.bearerAuth) {
    lines.push(`- \`${plan.envPrefix}_API_TOKEN\` — bearer token, sent as \`Authorization: Bearer <token>\` when set`);
  }
  for (const auth of plan.authHeaders) {
    lines.push(`- \`${auth.env}\` — value for the \`${auth.header}\` header, sent when set`);
  }
  lines.push('', '## Tools', '', '| Tool | Operation |', '| --- | --- |');
  for (const tool of plan.tools) {
    lines.push(`| \`${tool.name}\` | ${tool.method} ${tool.path} |`);
  }
  if (plan.skipped.length > 0) {
    lines.push('', '## Skipped operations', '', 'Not generated in v1:', '');
    for (const skipped of plan.skipped) {
      lines.push(`- \`${skipped.operationId}\` (${skipped.method} ${skipped.path}) — ${skipped.reason}`);
    }
  }
  lines.push('');
  return lines.join('\n');
}

/**
 * Create the MCP transformer. The document is captured directly (Forge's
 * public surface intentionally does not expose the raw document), and the
 * returned TransformerFn emits through the Forge instance it is given.
 */
export function createMcpTransformer(doc: OpenAPIV3.Document, options: McpTransformerOptions = {}): TransformerFn {
  const plan = buildMcpPlan(doc, options);
  return async (forge: Forge): Promise<void> => {
    forge.emit('server.js', renderServerJs(plan));
    forge.emit('package.json', renderPackageJson(plan));
    forge.emit('README.md', renderReadme(plan));
    if (plan.skipped.length > 0) {
      console.warn(
        `forge-transformer-mcp: skipped ${plan.skipped.length} operation(s): ${plan.skipped
          .map((s) => `${s.operationId} (${s.reason})`)
          .join('; ')}`,
      );
    }
  };
}
