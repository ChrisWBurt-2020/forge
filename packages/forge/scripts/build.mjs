// Builds the library plugins are written with, @cloudflare/forge/plugin:
//
//     node scripts/build.mjs [--out <dir>]
//
// It generates the TypeScript bindings of plugin/forge.wit into src/wit
// with jco, then compiles src/index.mts against them into index.mjs and
// index.d.mts in <dir>, plugin/ unless --out says otherwise. A WIT the
// library doesn't follow fails to compile.
//
// scripts/archive.mjs runs it too. It needs this directory's dev
// dependencies: run pnpm install here first.

import { resolve } from 'node:path';
import { parseArgs } from 'node:util';

import { buildPlugin, fail } from './platforms.mjs';

try {
  const { values } = parseArgs({ options: { out: { type: 'string' } } });
  buildPlugin(values.out && resolve(values.out));
} catch (err) {
  fail(err);
}
