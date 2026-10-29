#!/usr/bin/env node
/**
 * Development-only cleanup for the Native Messaging smoke.
 *
 * Removes only the registration and directory created by setup.mjs. It refuses
 * to delete a registry key or directory it cannot prove it owns.
 */
import { execFileSync } from "node:child_process";
import { readFile, rm, stat } from "node:fs/promises";
import * as path from "node:path";

function fail(message) {
  process.stderr.write(`cleanup: ${message}\n`);
  process.exit(1);
}

function parseArguments(argv) {
  const options = { root: "", hostName: "" };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!value) fail(`missing value for ${flag}`);
    if (flag === "--root") options.root = path.resolve(value);
    else if (flag === "--host") options.hostName = value;
    else fail(`unknown option ${flag}`);
    index += 1;
  }
  if (!options.root) fail("--root is required");
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(options.hostName)) fail("--host is required");
  return options;
}

function registryValue(key) {
  try {
    const output = execFileSync("reg", ["query", key, "/ve"], { encoding: "utf8" });
    const match = /REG_SZ\s+(.+)$/mu.exec(output);
    return match?.[1]?.trim() ?? "";
  } catch {
    return null;
  }
}

function registryExists(key) {
  try {
    execFileSync("reg", ["query", key], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

const options = parseArguments(process.argv.slice(2));
const key = `HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\${options.hostName}`;
const manifestPath = path.join(options.root, "native-host.json");

const current = registryValue(key);
if (current === null) {
  process.stdout.write(`registry: ${key} is not registered\n`);
} else if (path.resolve(current) !== path.resolve(manifestPath)) {
  fail(`${key} points to ${current}, which is not this smoke root; refusing to remove it`);
} else {
  execFileSync("reg", ["delete", key, "/f"], { stdio: "ignore" });
  if (registryExists(key)) fail(`${key} is still registered after deletion`);
  process.stdout.write(`registry: removed ${key}\n`);
}

try {
  await stat(manifestPath);
} catch {
  // The directory is already gone or was never created by setup.mjs.
}

const marker = path.join(options.root, "extension", "manifest.json");
try {
  const manifest = JSON.parse(await readFile(marker, "utf8"));
  if (!Array.isArray(manifest.permissions) || !manifest.permissions.includes("nativeMessaging")) {
    fail(`${options.root} does not look like a smoke environment; refusing to delete it`);
  }
} catch {
  fail(`${options.root} has no readable smoke manifest; refusing to delete it`);
}

await rm(options.root, { recursive: true, force: true });
process.stdout.write(`directory: removed ${options.root}\n`);
