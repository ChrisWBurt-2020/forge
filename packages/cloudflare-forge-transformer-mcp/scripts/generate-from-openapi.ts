#!/usr/bin/env node
/**
 * CLI: generate an MCP server from an OpenAPI spec.
 *
 *   node dist/cli.js <openapi.json|openapi.yaml> --out <dir>
 *     [--server-name <name>] [--server-version <version>] [--env-prefix <PREFIX>]
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Forge } from '@cloudflare/forge';
import type { OpenAPIV3 } from 'openapi-types';
import { parse as parseYaml } from 'yaml';
import { createMcpTransformer } from '../src/index.js';

interface Args {
  openapi?: string;
  out?: string;
  serverName?: string;
  serverVersion?: string;
  envPrefix?: string;
}

function usage(): never {
  console.error(
    [
      'Usage: forge-transformer-mcp <openapi> --out <dir> [options]',
      '',
      'Options:',
      '  --out <dir>              Output directory (required; cleaned before writing)',
      '  --server-name <name>     Generated server/package name (default: <spec title slug>-mcp-server)',
      '  --server-version <ver>   Generated server version (default: spec info.version)',
      '  --env-prefix <PREFIX>    Env var prefix (default: derived from server name)',
    ].join('\n'),
  );
  process.exit(2);
}

function parseArgs(argv: string[]): Args {
  const args: Args = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    const next = (): string => {
      const value = argv[++i];
      if (value === undefined) usage();
      return value;
    };
    if (arg === '--out') args.out = next();
    else if (arg === '--server-name') args.serverName = next();
    else if (arg === '--server-version') args.serverVersion = next();
    else if (arg === '--env-prefix') args.envPrefix = next();
    else if (arg === '--help' || arg === '-h') usage();
    else if (!arg.startsWith('--') && args.openapi === undefined) args.openapi = arg;
    else usage();
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));
if (!args.openapi || !args.out) usage();

const specPath = resolve(args.openapi);
const text = readFileSync(specPath, 'utf8');
const doc = (specPath.endsWith('.json') ? JSON.parse(text) : parseYaml(text)) as OpenAPIV3.Document;

const forge = new Forge(doc);
const files = await forge.transform(
  createMcpTransformer(doc, {
    serverName: args.serverName,
    serverVersion: args.serverVersion,
    envPrefix: args.envPrefix,
  }),
);
await forge.finalize(resolve(args.out), files, { clean: true });
console.log(`forge-transformer-mcp: generated ${files.length} files in ${resolve(args.out)}`);
