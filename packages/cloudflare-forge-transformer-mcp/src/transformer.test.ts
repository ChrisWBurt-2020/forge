import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { Forge } from '@cloudflare/forge';
import type { OpenAPIV3 } from 'openapi-types';
import { buildMcpPlan, createMcpTransformer } from './transformer.js';

const fixture = {
  openapi: '3.0.0',
  info: { title: 'Widget API', version: '1.2.0' },
  servers: [{ url: 'https://api.example.com/v1' }],
  components: {
    securitySchemes: {
      bearerAuth: { type: 'http', scheme: 'bearer' },
      apiKeyHeader: { type: 'apiKey', in: 'header', name: 'X-Widget-Key' },
    },
    schemas: {
      Widget: {
        type: 'object',
        required: ['name'],
        properties: { name: { type: 'string' }, size: { type: 'integer' } },
      },
    },
  },
  security: [{ bearerAuth: [] }],
  paths: {
    '/widgets/{id}': {
      get: {
        operationId: 'getWidget',
        summary: 'Get a widget',
        parameters: [
          { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'verbose', in: 'query', schema: { type: 'boolean' } },
        ],
        responses: {
          '200': {
            description: 'ok',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/Widget' } } },
          },
        },
      },
    },
    '/widgets': {
      post: {
        operationId: 'createWidget',
        description: 'Create a widget',
        parameters: [{ name: 'X-Widget-Key', in: 'header', schema: { type: 'string' } }],
        requestBody: {
          required: true,
          content: { 'application/json': { schema: { $ref: '#/components/schemas/Widget' } } },
        },
        responses: {
          '201': {
            description: 'created',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/Widget' } } },
          },
          '402': { description: 'denied', content: { 'application/json': { schema: { type: 'object' } } } },
        },
      },
    },
    '/widgets/upload': {
      post: {
        operationId: 'uploadWidget',
        requestBody: { content: { 'multipart/form-data': { schema: { type: 'object' } } } },
        responses: { '200': { description: 'ok', content: { 'application/json': { schema: { type: 'object' } } } } },
      },
    },
    '/widgets/stream': {
      get: {
        operationId: 'streamWidgets',
        responses: { '200': { description: 'sse', content: { 'text/event-stream': { schema: { type: 'string' } } } } },
      },
    },
    '/widgets/{id}/audio': {
      get: {
        operationId: 'getWidgetAudio',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        responses: {
          '200': { description: 'audio', content: { 'audio/mpeg': { schema: { type: 'string', format: 'binary' } } } },
        },
      },
    },
  },
} as unknown as OpenAPIV3.Document;

describe('buildMcpPlan', () => {
  const plan = buildMcpPlan(fixture);

  test('derives server identity and auth wiring from the spec', () => {
    assert.equal(plan.serverName, 'widget-api-mcp-server');
    assert.equal(plan.serverVersion, '1.2.0');
    assert.equal(plan.envPrefix, 'WIDGET_API');
    assert.equal(plan.baseUrlDefault, 'https://api.example.com/v1');
    assert.equal(plan.bearerAuth, true);
    assert.deepEqual(plan.authHeaders, [{ header: 'X-Widget-Key', env: 'WIDGET_API_X_WIDGET_KEY' }]);
  });

  test('generates tools for JSON operations with params and body', () => {
    const names = plan.tools.map((t) => t.name).sort();
    assert.deepEqual(names, ['createWidget', 'getWidget']);

    const get = plan.tools.find((t) => t.name === 'getWidget')!;
    assert.equal(get.method, 'GET');
    assert.deepEqual(get.pathParams, ['id']);
    assert.deepEqual(get.queryParams, ['verbose']);
    assert.equal(get.hasBody, false);
    const schema = get.inputSchema as { required?: string[] };
    assert.deepEqual(schema.required, ['id']);

    const create = plan.tools.find((t) => t.name === 'createWidget')!;
    assert.equal(create.hasBody, true);
    // the apiKey header parameter is auth (env), never a tool argument
    assert.deepEqual(create.headerParams, []);
    const props = (create.inputSchema as { properties: Record<string, unknown> }).properties;
    assert.ok(!('X-Widget-Key' in props));
    // $ref body schema is inlined
    const body = props['body'] as { properties: Record<string, unknown> };
    assert.ok('name' in body.properties);
    assert.ok('size' in body.properties);
  });

  test('skips multipart, streaming, and binary operations with reasons', () => {
    const reasons = Object.fromEntries(plan.skipped.map((s) => [s.operationId, s.reason]));
    assert.match(reasons['uploadWidget'] ?? '', /multipart/);
    assert.match(reasons['streamWidgets'] ?? '', /streaming/);
    assert.match(reasons['getWidgetAudio'] ?? '', /binary/);
  });
});

describe('buildMcpPlan env prefix', () => {
  test('digit-leading spec titles get a shell-valid API_ prefix', () => {
    const doc = {
      openapi: '3.0.0',
      info: { title: '9router Agent Surface', version: '2.0.0' },
      paths: {},
    } as unknown as OpenAPIV3.Document;
    const plan = buildMcpPlan(doc);
    assert.equal(plan.serverName, '9router-agent-surface-mcp-server');
    assert.equal(plan.envPrefix, 'API_9ROUTER_AGENT_SURFACE');
  });
});

describe('createMcpTransformer', () => {
  test('emits server.js, package.json, README.md through Forge', async () => {
    const forge = new Forge(fixture);
    const files = await forge.transform(createMcpTransformer(fixture));
    assert.deepEqual(files.map((f) => f.path).sort(), ['README.md', 'package.json', 'server.js']);
    const server = files.find((f) => f.path === 'server.js')!.content;
    assert.match(server, /createWidget/);
    assert.match(server, /ListToolsRequestSchema/);
    assert.ok(!server.includes('__CONFIG_JSON__'));
    assert.ok(!server.includes('__TOOLS_JSON__'));
    const pkg = JSON.parse(files.find((f) => f.path === 'package.json')!.content) as { name: string };
    assert.equal(pkg.name, 'widget-api-mcp-server');
  });
});
