// Sets the version of @cloudflare/forge to the version in Cargo.toml.
//
//     node scripts/version.mjs

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { cargoVersion, npmDir, readJson } from './platforms.mjs';

const path = join(npmDir, 'package.json');
const pkg = readJson(path);
pkg.version = cargoVersion();
writeFileSync(path, `${JSON.stringify(pkg, null, 2)}\n`);
console.log(`@cloudflare/forge is now at ${pkg.version}`);
