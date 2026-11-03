#!/usr/bin/env node
/**
 * Creates and registers an isolated, test-only Collector Native Messaging host.
 * The selected Shelf is configured only in temporary MAGINALIA profile files;
 * the browser protocol never carries filesystem paths.
 */
import { randomUUID } from "node:crypto";
import { copyFile, lstat, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
  allowedOriginFor,
  assertHostName,
  assertSafeRoot,
  createExtensionKey,
  createMarker,
  createOwnerRecord,
  createWindowsRegistry,
  hostManifestDescription,
  isPathInside,
  registryKeyFor,
  shelfMarker,
  yamlShelfLocation
} from "../native-host-smoke/lib.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const COPIED_FILES = [
  "host-client.js", "service-worker.js", "outbox.js", "manifest.json", "popup.html", "popup.css", "popup.js",
  "capture.html", "capture.css", "capture.js", "icon..png"
];
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function parseArguments(argv) {
  const options = {
    root: path.join(os.tmpdir(), `maginalia-collector-e2e-${randomUUID()}`),
    desktopHost: "",
    shelfRoot: "",
    disposable: false
  };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === "--disposable") { options.disposable = true; continue; }
    const value = argv[index + 1];
    if (!value) throw new Error("missing argument value");
    if (flag === "--root") options.root = path.resolve(value);
    else if (flag === "--desktop-host") options.desktopHost = path.resolve(value);
    else if (flag === "--shelf-root") options.shelfRoot = path.resolve(value);
    else throw new Error("unknown argument");
    index += 1;
  }
  if (!path.isAbsolute(options.desktopHost)) throw new Error("a built Desktop Native Host is required");
  if (options.disposable === Boolean(options.shelfRoot)) throw new Error("choose exactly one of --disposable or --shelf-root");
  if (isPathInside(REPO_ROOT, options.root) || path.resolve(options.root) === REPO_ROOT) throw new Error("test root must be outside the repository");
  if (options.shelfRoot && (isPathInside(options.shelfRoot, options.root) || isPathInside(options.root, options.shelfRoot))) {
    throw new Error("test root and selected Shelf must not contain one another");
  }
  return options;
}

async function inspectSelectedShelf(root) {
  const rootInfo = await lstat(root);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) throw new Error("selected Shelf root is not a regular directory");
  const entries = await readdir(root, { withFileTypes: true });
  const markerNames = entries.filter((entry) => entry.name.toLowerCase().endsWith(".magi"));
  if (markerNames.length !== 1 || !markerNames[0].isFile()) throw new Error("selected Shelf marker is ambiguous or unavailable");
  const markerText = await readFile(path.join(root, markerNames[0].name), "utf8");
  const version = /^\s*version\s*=\s*1\s*$/mu.test(markerText);
  const type = /^\s*type\s*=\s*["']?shelf["']?\s*(?:#.*)?$/mu.test(markerText);
  const match = /^\s*id\s*=\s*["']?([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})["']?\s*(?:#.*)?$/imu.exec(markerText);
  if (!version || !type || !match || !UUID_PATTERN.test(match[1])) throw new Error("selected Shelf marker is invalid");
  const library = JSON.parse(await readFile(path.join(root, "library.json"), "utf8"));
  if (library?.type !== "library" || !["0.1", "0.4"].includes(library.version)
    || typeof library.booksPath !== "string" || typeof library.annotationsPath !== "string") {
    throw new Error("selected Shelf library configuration is invalid");
  }
  for (const relative of [library.booksPath, library.annotationsPath]) {
    if (path.isAbsolute(relative) || relative.split(/[\\/]/u).some((part) => part === ".." || part === "")) {
      throw new Error("selected Shelf library path is invalid");
    }
    const child = await lstat(path.join(root, relative));
    if (!child.isDirectory() || child.isSymbolicLink()) throw new Error("selected Shelf record directory is unavailable");
  }
  return match[1];
}

async function createDisposableShelf(root) {
  const shelfRoot = path.join(root, "shelf-fixture");
  const shelfId = randomUUID();
  await mkdir(path.join(shelfRoot, "books"), { recursive: true });
  await mkdir(path.join(shelfRoot, "annotations"), { recursive: true });
  await writeFile(path.join(shelfRoot, "shelf.magi"), shelfMarker(shelfId), "utf8");
  await writeFile(path.join(shelfRoot, "library.json"), JSON.stringify({
    type: "library", version: "0.1", name: "Disposable E2E Shelf", booksPath: "books", annotationsPath: "annotations"
  }, null, 2) + "\n", "utf8");
  return { root: shelfRoot, id: shelfId };
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (!path.isAbsolute(options.root)) throw new Error("test root must be absolute");
  const root = assertSafeRoot(options.root);
  const nodeInfo = await lstat(process.execPath);
  if (!nodeInfo.isFile()) throw new Error("Node executable is unavailable");
  const shelf = options.disposable
    ? { root: "", id: "" }
    : { root: options.shelfRoot, id: await inspectSelectedShelf(options.shelfRoot) };
  try { await lstat(root); throw new Error("test root already exists"); }
  catch (error) { if (error?.code !== "ENOENT") throw error; }

  const registry = createWindowsRegistry();
  const hostName = `org.maginalia.collector_e2e_${randomUUID().slice(0, 8)}`;
  assertHostName(hostName);
  const registryKey = registryKeyFor(hostName);
  if (await registry.exists(registryKey)) throw new Error("test Host name is already registered");

  await mkdir(root, { recursive: false });
  const extensionDir = path.join(root, "extension");
  const hostLocationPath = path.join(root, "host-shelf_location.yml");
  const descriptorPath = path.join(root, "descriptor.json");
  const nativeHostPath = path.join(root, "native-host.json");
  const launcherPath = path.join(root, "launcher.cmd");
  const ownerPath = path.join(root, "smoke-owner.json");
  const coordinationRoot = path.join(root, "coordination");
  const desktopAppDataRoot = path.join(root, "desktop-appdata");
  const desktopUserData = path.join(desktopAppDataRoot, "Electron");
  await mkdir(extensionDir);
  await mkdir(coordinationRoot);
  await mkdir(desktopUserData, { recursive: true });

  for (const file of COPIED_FILES) await copyFile(path.join(REPO_ROOT, file), path.join(extensionDir, file));
  const manifest = JSON.parse(await readFile(path.join(extensionDir, "manifest.json"), "utf8"));
  const extensionKey = createExtensionKey();
  manifest.permissions = [...new Set([...(manifest.permissions ?? []), "nativeMessaging"])];
  manifest.key = extensionKey.key;
  manifest.name = "MAGINALIA Collector isolated E2E";
  await writeFile(path.join(extensionDir, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n", "utf8");

  const selectedShelf = options.disposable ? await createDisposableShelf(root) : shelf;
  await writeFile(hostLocationPath, yamlShelfLocation(selectedShelf.root), "utf8");
  const desktopLocationPath = path.join(desktopUserData, "shelf_location.yml");
  await writeFile(desktopLocationPath, yamlShelfLocation(selectedShelf.root), "utf8");
  await writeFile(descriptorPath, JSON.stringify({
    experimental: true,
    shelfLocationPath: hostLocationPath,
    expectedShelfId: selectedShelf.id,
    allowedOrigin: allowedOriginFor(extensionKey.id),
    testOnlyWritesEnabled: true,
    coordinationRoot
  }, null, 2) + "\n", "utf8");
  await writeFile(launcherPath, [
    "@echo off",
    `set "MAGINALIA_COLLECTOR_EXPERIMENTAL_DESCRIPTOR=${descriptorPath}"`,
    'set "MAGINALIA_COLLECTOR_TEST_ONLY=1"',
    ...(options.disposable ? ['set "MAGINALIA_COLLECTOR_TEST_RECOVERY_PROBE_ONCE=1"'] : []),
    `"${process.execPath}" "${options.desktopHost}" %*`,
    ""
  ].join("\r\n"), "utf8");
  const marker = createMarker();
  await writeFile(nativeHostPath, JSON.stringify({
    name: hostName,
    description: hostManifestDescription(marker),
    path: launcherPath,
    type: "stdio",
    allowed_origins: [allowedOriginFor(extensionKey.id)]
  }, null, 2) + "\n", "utf8");
  await writeFile(ownerPath, JSON.stringify(createOwnerRecord({
    marker, hostName, extensionId: extensionKey.id, root
  }), null, 2) + "\n", "utf8");

  // The unique key is checked before creation; only this test host name is registered.
  if (await registry.exists(registryKey)) throw new Error("test Host name appeared during setup");
  registry.write(registryKey, nativeHostPath);

  process.stdout.write(JSON.stringify({
    mode: options.disposable ? "disposable-shelf" : "selected-shelf",
    root,
    extensionDir,
    extensionId: extensionKey.id,
    hostName,
    desktopAppDataRoot,
    desktopUserData
  }, null, 2) + "\n");
}

main().catch(() => {
  process.stderr.write("prepare: isolated E2E environment creation failed; inspect only the new disposable root.\n");
  process.exitCode = 1;
});
