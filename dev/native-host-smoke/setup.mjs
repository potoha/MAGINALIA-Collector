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
 * This script does not modify the repository, the user's Chrome profile, or any
 * existing host registration. It only writes inside --root and refuses to reuse
 * an existing registry key.
 */
import { execFileSync } from "node:child_process";
import { createHash, generateKeyPairSync, randomUUID } from "node:crypto";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

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
  "icon..png"
];

function fail(message) {
  process.stderr.write(`setup: ${message}\n`);
  process.exit(1);
}

function parseArguments(argv) {
  const options = {
    root: path.join(os.tmpdir(), `maginalia-collector-nh-smoke-${Date.now()}`),
    hostName: `org.maginalia.smoke_${randomUUID().slice(0, 8)}`,
    desktopHost: "",
    shelfName: "Smoke Private Shelf"
  };

  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!value) {
      fail(`missing value for ${flag}`);
    }
    if (flag === "--root") options.root = path.resolve(value);
    else if (flag === "--host") options.hostName = value;
    else if (flag === "--desktop-host") options.desktopHost = path.resolve(value);
    else if (flag === "--shelf-name") options.shelfName = value;
    else fail(`unknown option ${flag}`);
    index += 1;
  }

  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(options.hostName)) {
    fail("host name must match ^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$");
  }
  if (!options.desktopHost) {
    fail("--desktop-host is required (absolute path to the built experimental collector native host .js)");
  }

  const root = path.resolve(options.root);
  const relative = path.relative(REPO_ROOT, root);
  if (relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))) {
    fail("--root must be outside the repository");
  }

  return { ...options, root };
}

/** Chrome derives an unpacked extension ID from the manifest `key` (SPKI DER). */
function extensionIdForPublicKey(der) {
  const digest = createHash("sha256").update(der).digest("hex").slice(0, 32);
  return Array.from(digest, (character) => String.fromCharCode(97 + parseInt(character, 16))).join("");
}

function createExtensionKey() {
  const { publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const der = publicKey.export({ type: "spki", format: "der" });
  return { key: der.toString("base64"), id: extensionIdForPublicKey(der) };
}

function yamlShelfLocation(registryPath) {
  return [
    "version: 1",
    "private_shelf:",
    "  registry: " + JSON.stringify(registryPath),
    "  urls:",
    "    github: null",
    "    homepage: null",
    "    other: []",
    "public_shelf:",
    "  registry: null",
    "  urls:",
    "    github: null",
    "    homepage: null",
    "    other: []",
    ""
  ].join("\n");
}

function shelfMarker(shelfId) {
  return ["# Disposable smoke fixture shelf marker.", "version = 1", "type = shelf", `id = ${shelfId}`, ""].join("\n");
}

async function hostIsRegistered(hostName) {
  try {
    execFileSync("reg", ["query", `HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\${hostName}`], {
      stdio: "ignore"
    });
    return true;
  } catch {
    return false;
  }
}

const options = parseArguments(process.argv.slice(2));

if (await hostIsRegistered(options.hostName)) {
  fail(`a Chrome native messaging host is already registered as ${options.hostName}; choose another --host`);
}

const { key, id: extensionId } = createExtensionKey();
const hostName = options.hostName;
const shelfId = randomUUID();

const extensionDir = path.join(options.root, "extension");
const shelfDir = path.join(options.root, "shelf");
const profileDir = path.join(options.root, "profile");
const descriptorPath = path.join(options.root, "descriptor.json");
const hostManifestPath = path.join(options.root, "native-host.json");
const launcherPath = path.join(options.root, "launcher.cmd");
const shelfLocationPath = path.join(options.root, "shelf_location.yml");

try {
  await mkdir(extensionDir, { recursive: true });
  await mkdir(path.join(shelfDir, "books"), { recursive: true });
  await mkdir(path.join(shelfDir, "annotations"), { recursive: true });
  await mkdir(profileDir, { recursive: true });

  for (const file of COPIED_FILES) {
    await copyFile(path.join(REPO_ROOT, file), path.join(extensionDir, file));
  }

  // The production manifest must stay free of nativeMessaging, host names and
  // extension identities. Only this disposable copy gains the permission.
  const manifest = JSON.parse(await readFile(path.join(REPO_ROOT, "manifest.json"), "utf8"));
  manifest.permissions = Array.from(new Set([...(manifest.permissions ?? []), "nativeMessaging"]));
  manifest.key = key;
  await writeFile(path.join(extensionDir, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n", "utf8");

  await writeFile(
    path.join(shelfDir, "library.json"),
    JSON.stringify(
      { type: "library", version: "0.1", name: options.shelfName, booksPath: "books", annotationsPath: "annotations" },
      null,
      2
    ) + "\n",
    "utf8"
  );
  await writeFile(path.join(shelfDir, "shelf.magi"), shelfMarker(shelfId), "utf8");
  await writeFile(shelfLocationPath, yamlShelfLocation(shelfDir), "utf8");

  await writeFile(
    descriptorPath,
    JSON.stringify(
      { experimental: true, shelfLocationPath, expectedShelfId: shelfId, allowedOrigin: `chrome-extension://${extensionId}/` },
      null,
      2
    ) + "\n",
    "utf8"
  );

  await writeFile(
    launcherPath,
    ["@echo off", `"${process.execPath}" "${options.desktopHost}" %*`, ""].join("\r\n"),
    "utf8"
  );

  await writeFile(
    hostManifestPath,
    JSON.stringify(
      {
        name: hostName,
        description: "Disposable MAGINALIA Collector smoke host",
        path: launcherPath,
        type: "stdio",
        allowed_origins: [`chrome-extension://${extensionId}/`]
      },
      null,
      2
    ) + "\n",
    "utf8"
  );
} catch (error) {
  fail(error instanceof Error ? error.message : "could not create the smoke environment");
}

process.stdout.write(
  JSON.stringify(
    {
      experimental: true,
      root: options.root,
      extensionDir,
      extensionId,
      profileDir,
      shelfDir,
      expectedShelfId: shelfId,
      shelfLocationPath,
      descriptorPath,
      hostManifestPath,
      launcherPath,
      desktopHost: options.desktopHost,
      hostName,
      registryKey: `HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\${hostName}`,
      hostProfile: { hostName },
      hostProfileKey: (await readFile(path.join(REPO_ROOT, "host-client.js"), "utf8")).match(
        /HOST_PROFILE_KEY = "([^"]+)"/
      )?.[1] ?? null
    },
    null,
    2
  ) + "\n"
);
