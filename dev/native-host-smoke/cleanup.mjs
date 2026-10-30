#!/usr/bin/env node
/**
 * Development-only cleanup for the Native Messaging smoke.
 *
 * Removes only the registration and directory created by setup.mjs, and only
 * after proving ownership: the `smoke-owner.json` marker, the host name, the
 * root path, the extension ID derived from the copied manifest `key`, the
 * manifest `allowed_origins`, and the current registry value must all agree.
 * Anything unproven, unknown, moved, forged, or linked (symbolic link or
 * junction anywhere in the tree) stops the run before a single deletion.
 *
 * All verification lives in ./lib.mjs. This CLI only parses arguments, supplies
 * the real Windows registry adapter and reports what happened.
 */
import * as path from "node:path";

import { createWindowsRegistry, registryKeyFor, removeSmokeEnvironment, SmokeError } from "./lib.mjs";

function parseArguments(argv) {
  const options = { root: "", hostName: "" };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!value) throw new SmokeError(`missing value for ${flag}`);
    if (flag === "--root") options.root = path.resolve(value);
    else if (flag === "--host") options.hostName = value;
    else throw new SmokeError(`unknown option ${flag}`);
    index += 1;
  }
  if (!options.root) throw new SmokeError("--root is required");
  if (!options.hostName) throw new SmokeError("--host is required");
  return options;
}

try {
  const options = parseArguments(process.argv.slice(2));
  const result = await removeSmokeEnvironment({
    root: options.root,
    hostName: options.hostName,
    registry: createWindowsRegistry()
  });

  if (result.removedRegistry) {
    process.stdout.write(`registry: removed ${result.registryKey}\n`);
  } else {
    process.stdout.write(`registry: ${registryKeyFor(options.hostName)} was not registered\n`);
  }
  process.stdout.write(`directory: removed ${result.root}\n`);
} catch (error) {
  process.stderr.write(`cleanup: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
