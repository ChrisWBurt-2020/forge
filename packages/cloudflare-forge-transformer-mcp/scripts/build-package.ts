import { chmodSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildSync } from 'esbuild';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = dirname(SCRIPT_DIR);
const DIST = join(PKG_ROOT, 'dist');

rmSync(DIST, { recursive: true, force: true });
mkdirSync(DIST, { recursive: true });

buildSync({
  entryPoints: [join(PKG_ROOT, 'scripts', 'generate-from-openapi.ts')],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  outfile: join(DIST, 'cli.js'),
  // Bundled CJS dependencies (yaml) call require() for node builtins;
  // give the ESM bundle a real require.
  banner: {
    js: "import { createRequire } from 'node:module';\nconst require = createRequire(import.meta.url);",
  },
});

chmodSync(join(DIST, 'cli.js'), 0o755);
console.log('==> Built @cloudflare/forge-transformer-mcp CLI');
