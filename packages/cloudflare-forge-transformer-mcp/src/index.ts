/**
 * @cloudflare/forge-transformer-mcp — generate a Model Context Protocol
 * server (stdio, one tool per operation) from an OpenAPI specification.
 */
export { buildMcpPlan, createMcpTransformer, derefSchema } from './transformer.js';
export type { McpGenerationPlan, McpToolDef, McpTransformerOptions, SkippedOperation } from './transformer.js';
