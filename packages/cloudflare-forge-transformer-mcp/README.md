# @cloudflare/forge-transformer-mcp

Generate a Model Context Protocol (MCP) server from an OpenAPI specification.
One MCP tool per operation, served over stdio, calling the API over HTTP.

Where `@cloudflare/forge-transformer-sdk-ts` generates a client library for
applications to embed, this transformer generates a ready-to-run server that
any MCP host (agent harness, IDE, CLI) can spawn directly.

## Usage

```sh
pnpm build   # bundles the CLI to dist/cli.js
node dist/cli.js <openapi.json> --out <dir> \
  [--server-name <name>] [--env-prefix <PREFIX>]
```

Output (in `<dir>`):

- `server.js` — the MCP server (plain ESM; run with `node server.js`)
- `package.json` — depends only on `@modelcontextprotocol/sdk`
- `README.md` — tools, configuration, and any skipped operations

## v1 scope

- JSON request/response bodies. Operations with form-encoded or multipart
  request bodies, streaming (SSE) responses, or binary responses are
  skipped and listed in the generated README — never silently dropped.
- Auth comes from the environment, never from tool arguments:
  `<PREFIX>_BASE_URL`, `<PREFIX>_API_TOKEN` (bearer), and one variable per
  apiKey header security scheme (e.g. `<PREFIX>_X_WIDGET_KEY`).
- Implemented as a real `TransformerFn` over `@cloudflare/forge`
  (`createMcpTransformer`), with the plan builder (`buildMcpPlan`) kept
  pure for testing.
