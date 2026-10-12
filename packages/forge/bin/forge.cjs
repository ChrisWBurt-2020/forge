#!/usr/bin/env node
// Runs the forge binary for this platform. The package carries a binary for
// every platform it supports, at native/<os>-<cpu>/forge.

'use strict';

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const exe = process.platform === 'win32' ? 'forge.exe' : 'forge';

/** Prints `message` and exits with failure. */
function fail(message) {
  process.stderr.write(`forge: ${message}\n`);
  process.exit(1);
}

/** Returns the path to the forge binary for this platform. */
function binary() {
  // Lets you run a local build, such as target/debug/forge, through npm.
  if (process.env.FORGE_BINARY) {
    return process.env.FORGE_BINARY;
  }

  const platform = `${process.platform}-${process.arch}`;
  const native = path.join(__dirname, '..', 'native');
  const bin = path.join(native, platform, exe);
  if (!fs.existsSync(bin)) {
    const bundled = fs.existsSync(native) ? fs.readdirSync(native) : [];
    fail(
      bundled.length > 0
        ? `there is no forge binary for ${platform}; this package has them for ${bundled.join(', ')}`
        : 'this package has no forge binaries; build it with scripts/archive.mjs',
    );
  }
  return bin;
}

const bin = binary();
const result = spawnSync(bin, process.argv.slice(2), { stdio: 'inherit' });
if (result.error) {
  fail(`cannot run ${bin}: ${result.error.message}`);
}
if (result.signal) {
  // End this process the same way the binary ended.
  process.kill(process.pid, result.signal);
  // Reached only when the signal does not end the process; Node ignores
  // SIGPIPE, for one.
  process.exitCode = 128 + (os.constants.signals[result.signal] ?? 0);
} else {
  process.exitCode = result.status;
}
