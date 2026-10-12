// Publishes the tarball scripts/archive.mjs made, which has the binary for
// every platform:
//
//     node scripts/publish.mjs [npm publish options]
//
// Any options go to `npm publish`, such as --dry-run, --tag next, or
// --provenance. If the registry has this version already, it does nothing.

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';

import { checkVersion, display, distDir, fail, tarball } from './platforms.mjs';

const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const name = '@cloudflare/forge';

try {
  const version = checkVersion();
  const file = tarball(distDir, version);
  if (!existsSync(file)) {
    throw new Error(`${display(file)} does not exist; run node scripts/compile.mjs, then node scripts/archive.mjs`);
  }
  if (published(version)) {
    console.log(`${name}@${version} is published already`);
  } else {
    // Run from dist/ so that npm ignores this directory's package.json.
    execFileSync(npm, ['publish', file, ...process.argv.slice(2)], {
      cwd: distDir,
      stdio: 'inherit',
      shell: npm.endsWith('.cmd'),
    });
  }
} catch (err) {
  fail(err);
}

/** Reports whether the registry has @cloudflare/forge at `version`. */
function published(version) {
  try {
    const out = execFileSync(npm, ['view', `${name}@${version}`, 'version'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      shell: npm.endsWith('.cmd'),
    });
    return out.trim() === version;
  } catch {
    // npm view fails when the package doesn't exist at all.
    return false;
  }
}
