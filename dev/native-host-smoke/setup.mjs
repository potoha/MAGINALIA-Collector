#!/usr/bin/env node
/**
 * Development-only Native Messaging smoke setup for MAGINALIA Collector.
 *
 * Builds a disposable, isolated test environment outside this repository:
 * an unpacked Collector build with `nativeMessaging`, a throwaway extension
 * identity, a Shelf fixture, a host-visible descriptor, a launcher and a
 * test-only Chrome host manifest.
 *
 * Nothing here is a product contract. The protocol, descriptor, host name and
 * Shelf identity expectation are the experimental ones described in
 * docs/issue-4-native-host-client.md. Never point this at real research data.
 *
 * All creation and ownership logic lives in ./lib.mjs. This CLI only parses
 * arguments, supplies the real Windows registry adapter and prints the result.
 * It only writes inside a brand-new --root and refuses to reuse an existing
 * directory or an existing registry key.
 */
import { readFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

import { createSmokeEnvironment, createWindowsRegistry, isPathInside, SmokeError } from "./lib.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const COPIED_FILES = [
  "host-client.js",
  "service-worker.js",
  "outbox.js",
  "popup.html",
  "popup.css",
  "popup.js",
  "capture.html",
  "capture.css",
  "capture.js",
  "onboarding.html",
  "onboarding.css",
  "onboarding.js",
  "icon..png"
];

function parseArguments(argv) {
  const options = {
    root: path.join(os.tmpdir(), `maginalia-collector-nh-smoke-${randomUUID()}`),
    hostName: `org.maginalia.smoke_${randomUUID().slice(0, 8)}`,
    desktopHost: "",
    shelfName: "Smoke Private Shelf"
  };

  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!value) {
      throw new SmokeError(`missing value for ${flag}`);
    }
    if (flag === "--root") options.root = path.resolve(value);
    else if (flag === "--host") options.hostName = value;
    else if (flag === "--desktop-host") options.desktopHost = path.resolve(value);
    else if (flag === "--shelf-name") options.shelfName = value;
    else throw new SmokeError(`unknown option ${flag}`);
    index += 1;
  }

  if (!options.desktopHost) {
    throw new SmokeError(
      "--desktop-host is required (absolute path to the built experimental collector native host .js)"
    );
  }
  if (isPathInside(REPO_ROOT, options.root) || path.resolve(options.root) === REPO_ROOT) {
    throw new SmokeError("--root must be outside the repository");
  }

  return options;
}

async function hostProfileKey() {
  const source = await readFile(path.join(REPO_ROOT, "host-client.js"), "utf8");
  return source.match(/HOST_PROFILE_KEY = "([^"]+)"/)?.[1] ?? null;
}

try {
  const options = parseArguments(process.argv.slice(2));
  const environment = await createSmokeEnvironment({
    root: options.root,
    hostName: options.hostName,
    desktopHost: options.desktopHost,
    shelfName: options.shelfName,
    repositoryRoot: REPO_ROOT,
    copiedFiles: COPIED_FILES,
    registry: createWindowsRegistry()
  });

  process.stdout.write(
    JSON.stringify({ ...environment, hostProfileKey: await hostProfileKey() }, null, 2) + "\n"
  );
} catch (error) {
  process.stderr.write(`setup: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
