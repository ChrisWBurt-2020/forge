// Builds the release forge binary for every platform, or for the ones you
// name, into the crate's target directory:
//
//     node scripts/compile.mjs [--platform <os-cpu>]...
//
// Each platform builds with its own tool (see `builder` in platforms.mjs):
//
//   macOS    cargo build         needs a Mac and Xcode's command line tools
//   Linux    cross build         needs Docker running; see github.com/cross-rs/cross
//   Windows  cargo xwin build    downloads Microsoft's CRT and SDK the first time
//
// Install the tools with:
//
//     rustup target add <target>...   # the targets in platforms.mjs
//     cargo install cross --git https://github.com/cross-rs/cross
//     cargo install --locked cargo-xwin
//
// The binaries are built with the `wasm` feature, so they run plugins.
//
// Then pack them into the package with scripts/archive.mjs.

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, join } from 'node:path';
import { parseArgs } from 'node:util';

import { fail, platforms, repoDir } from './platforms.mjs';

try {
  const { values } = parseArgs({
    options: { platform: { type: 'string', multiple: true } },
  });
  compile(values.platform);
} catch (err) {
  fail(err);
}

/** Builds the binaries for the platforms in `only`, or for all of them. */
function compile(only) {
  const known = platforms.map((platform) => platform.id);
  const unknown = only?.filter((id) => !known.includes(id)) ?? [];
  if (unknown.length > 0) {
    throw new Error(`unknown platform ${unknown.join(', ')}; forge supports ${known.join(', ')}`);
  }
  const chosen = platforms.filter((platform) => !only || only.includes(platform.id));
  if (process.platform !== 'darwin' && chosen.some((platform) => platform.os === 'darwin')) {
    throw new Error('macOS binaries build only on a Mac; leave them out with --platform');
  }

  const installed = new Set(run('rustup', ['target', 'list', '--installed'], { capture: true }).split('\n'));
  const missing = chosen
    .filter((platform) => platform.builder !== 'cross' && !installed.has(platform.target))
    .map((platform) => platform.target);
  if (missing.length > 0) {
    // cross brings its own toolchain for its targets.
    throw new Error(`run rustup target add ${missing.join(' ')}`);
  }

  for (const platform of chosen) {
    console.log(`\n==> ${platform.id} (${platform.target}) with ${platform.builder}`);
    // `wasm` gives `--target wasm://`, which runs plugins.
    const args = ['build', '--release', '--locked', '--features', 'wasm', '--target', platform.target];
    switch (platform.builder) {
      case 'cargo':
        run('cargo', args);
        break;
      case 'cross':
        run(tool('cross', 'cargo install cross --git https://github.com/cross-rs/cross'), args);
        break;
      case 'xwin': {
        tool('cargo-xwin', 'cargo install --locked cargo-xwin');
        // Link the C runtime in, or the binary needs VCRUNTIME140.dll from
        // the Visual C++ Redistributable, which many machines don't have.
        const flags = `CARGO_TARGET_${platform.target.toUpperCase().replaceAll('-', '_')}_RUSTFLAGS`;
        const env = { [flags]: `${process.env[flags] ?? ''} -C target-feature=+crt-static`.trim() };
        run('cargo', ['xwin', ...args], { env });
        break;
      }
      default:
        throw new Error(`${platform.id} has no builder named ${platform.builder}`);
    }
  }
  console.log(`\nbuilt ${chosen.map((platform) => platform.id).join(', ')}`);
}

/**
 * Returns the path to the program `name`, looking on PATH and then in
 * cargo's bin directory, which `cargo install` puts things in but which
 * isn't always on PATH. Throws with `install` as the fix if there is none.
 */
function tool(name, install) {
  const cargoBin = join(process.env.CARGO_HOME ?? join(homedir(), '.cargo'), 'bin');
  const exe = process.platform === 'win32' ? `${name}.exe` : name;
  const found = [...(process.env.PATH ?? '').split(delimiter), cargoBin]
    .map((dir) => join(dir, exe))
    .find((path) => existsSync(path));
  if (!found) {
    throw new Error(`${name} is not installed; run ${install}`);
  }
  return found;
}

/**
 * Runs `cmd` with `args` in the crate's root, with `env` added to the
 * environment, and throws if it fails. Returns its standard output if
 * `capture` is set.
 */
function run(cmd, args, { capture = false, env = {} } = {}) {
  const result = spawnSync(cmd, args, {
    cwd: repoDir,
    env: { ...process.env, ...env },
    encoding: 'utf8',
    stdio: capture ? ['ignore', 'pipe', 'inherit'] : 'inherit',
  });
  if (result.error) {
    throw new Error(`cannot run ${cmd}: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new Error(`${cmd} ${args.join(' ')} failed`);
  }
  return result.stdout;
}
