/**
 * Shared core of the development-only Native Messaging smoke harness.
 *
 * `setup.mjs` and `cleanup.mjs` are thin CLIs over these functions, and
 * `tests/native-host-smoke.test.cjs` drives the same functions with an in-memory
 * registry adapter. Nothing here is a product contract.
 *
 * Ownership model: setup writes `smoke-owner.json` inside the root it created.
 * The record carries a 32-hex marker that is also embedded in the test-only
 * Chrome host manifest `description`, and the record binds the host name, the
 * throwaway extension ID and the absolute root path. Cleanup re-derives the
 * extension ID from the copied manifest `key` and refuses to delete anything
 * unless every part of that chain agrees.
 *
 * The experimental host descriptor accepts exactly four keys
 * (`experimental`, `shelfLocationPath`, `expectedShelfId`, `allowedOrigin`), so
 * the marker lives in the host manifest instead of the descriptor.
 */
import { createHash, generateKeyPairSync, randomBytes, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { chmod, copyFile, lstat, mkdir, readFile, readdir, rmdir, stat, unlink, writeFile } from "node:fs/promises";
import * as path from "node:path";

export const OWNER_FILE = "smoke-owner.json";
export const OWNER_KIND = "maginalia-collector-native-host-smoke";
export const OWNER_VERSION = 1;
export const HOST_MANIFEST_FILE = "native-host.json";
export const DESCRIPTOR_FILE = "descriptor.json";
export const SHELF_LOCATION_FILE = "shelf_location.yml";
export const LAUNCHER_FILE = "launcher.cmd";
export const EXTENSION_DIR = "extension";
export const REGISTRY_ROOT = "HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts";

export const MARKER_PATTERN = /^[0-9a-f]{32}$/;
export const HOST_NAME_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;

const MAX_TREE_DEPTH = 64;

export class SmokeError extends Error {
  constructor(message) {
    super(message);
    this.name = "SmokeError";
  }
}

export function registryKeyFor(hostName) {
  return `${REGISTRY_ROOT}\\${hostName}`;
}

export function allowedOriginFor(extensionId) {
  return `chrome-extension://${extensionId}/`;
}

/** Chrome derives an unpacked extension ID from the manifest `key` (SPKI DER). */
export function extensionIdForPublicKey(der) {
  const digest = createHash("sha256").update(der).digest("hex").slice(0, 32);
  return Array.from(digest, (character) => String.fromCharCode(97 + parseInt(character, 16))).join("");
}

export function createExtensionKey() {
  const { publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const der = publicKey.export({ type: "spki", format: "der" });
  return { key: der.toString("base64"), id: extensionIdForPublicKey(der) };
}

export function createMarker() {
  return randomBytes(16).toString("hex");
}

function samePath(left, right) {
  const a = path.resolve(left);
  const b = path.resolve(right);
  return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}

export function isPathInside(parent, candidate) {
  const relative = path.relative(path.resolve(parent), path.resolve(candidate));
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

export function assertHostName(hostName) {
  if (typeof hostName !== "string" || !HOST_NAME_PATTERN.test(hostName)) {
    throw new SmokeError("host name must match ^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$");
  }
}

export function assertSafeRoot(root) {
  if (typeof root !== "string" || !path.isAbsolute(root)) {
    throw new SmokeError("--root must be an absolute path");
  }
  const resolved = path.resolve(root);
  if (path.parse(resolved).root === resolved) {
    throw new SmokeError("--root must not be a filesystem root");
  }
  return resolved;
}

// ---------------------------------------------------------------------------
// Ownership record and cross-artifact binding
// ---------------------------------------------------------------------------

export function hostManifestDescription(marker) {
  return `Disposable MAGINALIA Collector smoke host [smoke-marker:${marker}]`;
}

export function markerFromDescription(description) {
  if (typeof description !== "string") return null;
  const match = /\[smoke-marker:([0-9a-f]{32})\]/u.exec(description);
  return match ? match[1] : null;
}

export function createOwnerRecord({ marker, hostName, extensionId, root, createdAt = new Date() }) {
  if (!MARKER_PATTERN.test(marker)) throw new SmokeError("ownership marker must be 32 lowercase hex characters");
  assertHostName(hostName);
  const createdAtIso = new Date(createdAt);
  if (Number.isNaN(createdAtIso.getTime())) {
    throw new SmokeError("ownership record needs a valid creation time");
  }
  const record = {
    kind: OWNER_KIND,
    version: OWNER_VERSION,
    marker,
    hostName,
    extensionId,
    root: path.resolve(root),
    createdAt: createdAtIso.toISOString()
  };
  if (typeof extensionId !== "string" || extensionId.length !== 32) {
    throw new SmokeError("ownership record needs the 32-character extension ID");
  }
  if (path.parse(record.root).root === record.root) {
    throw new SmokeError("ownership record needs a root below a filesystem root");
  }
  return record;
}

export function parseOwnerRecord(text) {
  let record;
  try {
    record = JSON.parse(text);
  } catch {
    throw new SmokeError(`${OWNER_FILE} is not valid JSON`);
  }
  if (!record || typeof record !== "object" || Array.isArray(record)) {
    throw new SmokeError(`${OWNER_FILE} is not an object`);
  }
  if (record.kind !== OWNER_KIND) {
    throw new SmokeError(`${OWNER_FILE} is not a smoke ownership record`);
  }
  if (record.version !== OWNER_VERSION) {
    throw new SmokeError(`${OWNER_FILE} has unsupported version ${String(record.version)}`);
  }
  if (typeof record.marker !== "string" || !MARKER_PATTERN.test(record.marker)) {
    throw new SmokeError(`${OWNER_FILE} has a malformed ownership marker`);
  }
  if (typeof record.hostName !== "string" || !HOST_NAME_PATTERN.test(record.hostName)) {
    throw new SmokeError(`${OWNER_FILE} has a malformed host name`);
  }
  if (typeof record.extensionId !== "string" || !/^[a-p]{32}$/u.test(record.extensionId)) {
    throw new SmokeError(`${OWNER_FILE} has a malformed extension ID`);
  }
  if (typeof record.root !== "string" || !path.isAbsolute(record.root)) {
    throw new SmokeError(`${OWNER_FILE} has a malformed root path`);
  }
  return record;
}

/**
 * Pure ownership check. Returns every problem it can prove, so a caller can
 * report all mismatches at once instead of one per run. An empty array means the
 * artifacts all describe the same smoke environment.
 */
export function collectOwnershipProblems({
  root,
  hostName,
  ownerRecord = null,
  hostManifest = null,
  extensionManifest = null,
  registryValue = null
}) {
  const problems = [];

  if (!ownerRecord) {
    problems.push(`${OWNER_FILE} is missing or unreadable, so ownership cannot be proven`);
    return problems;
  }

  if (ownerRecord.hostName !== hostName) {
    problems.push(`ownership record belongs to host ${ownerRecord.hostName}, not ${hostName}`);
  }
  if (!samePath(ownerRecord.root, root)) {
    problems.push(`ownership record belongs to ${ownerRecord.root}, not ${root}`);
  }

  const expectedOrigin = allowedOriginFor(ownerRecord.extensionId);

  if (!hostManifest) {
    problems.push(`${HOST_MANIFEST_FILE} is missing or unreadable`);
  } else {
    if (hostManifest.name !== hostName) {
      problems.push(`${HOST_MANIFEST_FILE} is registered as ${String(hostManifest.name)}, not ${hostName}`);
    }
    const marker = markerFromDescription(hostManifest.description);
    if (marker === null) {
      problems.push(`${HOST_MANIFEST_FILE} carries no smoke ownership marker`);
    } else if (marker !== ownerRecord.marker) {
      problems.push(`${HOST_MANIFEST_FILE} marker does not match ${OWNER_FILE}`);
    }
    const origins = hostManifest.allowed_origins;
    if (!Array.isArray(origins) || origins.length !== 1 || origins[0] !== expectedOrigin) {
      problems.push(`${HOST_MANIFEST_FILE} allowed_origins do not match ${expectedOrigin}`);
    }
  }

  if (!extensionManifest) {
    problems.push(`${EXTENSION_DIR}/manifest.json is missing or unreadable`);
  } else {
    const permissions = extensionManifest.permissions;
    if (!Array.isArray(permissions) || !permissions.includes("nativeMessaging")) {
      problems.push(`${EXTENSION_DIR}/manifest.json has no nativeMessaging permission`);
    }
    if (typeof extensionManifest.key !== "string" || extensionManifest.key.length === 0) {
      problems.push(`${EXTENSION_DIR}/manifest.json has no throwaway key`);
    } else {
      let derivedId = null;
      try {
        derivedId = extensionIdForPublicKey(Buffer.from(extensionManifest.key, "base64"));
      } catch {
        derivedId = null;
      }
      if (derivedId !== ownerRecord.extensionId) {
        problems.push(`${EXTENSION_DIR}/manifest.json does not derive the recorded extension ID`);
      }
    }
  }

  if (registryValue !== null && registryValue !== undefined) {
    const expectedManifest = path.join(root, HOST_MANIFEST_FILE);
    if (registryValue === "") {
      problems.push(`${registryKeyFor(hostName)} exists without a default value`);
    } else if (!samePath(registryValue, expectedManifest)) {
      problems.push(`${registryKeyFor(hostName)} points at ${registryValue}, not ${expectedManifest}`);
    }
  }

  return problems;
}

export function verifyOwnership(input) {
  const problems = collectOwnershipProblems(input);
  if (problems.length > 0) {
    throw new SmokeError(problems.join("; "));
  }
}

// ---------------------------------------------------------------------------
// Filesystem helpers
// ---------------------------------------------------------------------------

async function readJsonOrNull(filePath) {
  try {
    return JSON.parse(await readFile(filePath, "utf8"));
  } catch {
    return null;
  }
}

/** Lists symbolic links and NTFS junctions anywhere below `dir` without following them. */
export async function findReparsePoints(dir) {
  const found = [];

  async function walk(current, depth) {
    if (depth > MAX_TREE_DEPTH) {
      throw new SmokeError(`directory nesting is too deep below ${current}`);
    }
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const entryPath = path.join(current, entry.name);
      const info = await lstat(entryPath);
      if (info.isSymbolicLink()) {
        found.push(entryPath);
        continue;
      }
      if (info.isDirectory()) {
        await walk(entryPath, depth + 1);
      }
    }
  }

  await walk(dir, 0);
  return found;
}

async function removeFile(filePath) {
  try {
    await unlink(filePath);
  } catch (error) {
    if (error?.code !== "EPERM" && error?.code !== "EACCES") throw error;
    await chmod(filePath, 0o666);
    await unlink(filePath);
  }
}

/**
 * Deletes a tree bottom-up, re-checking every entry. It never follows, and never
 * removes, a symbolic link or junction: meeting one aborts the whole deletion so
 * the operator sees the path instead of losing the link target.
 */
export async function removeTree(dir, depth = 0) {
  if (depth > MAX_TREE_DEPTH) {
    throw new SmokeError(`directory nesting is too deep below ${dir}`);
  }
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const entryPath = path.join(dir, entry.name);
    const info = await lstat(entryPath);
    if (info.isSymbolicLink()) {
      throw new SmokeError(`refusing to delete a symbolic link or junction: ${entryPath}`);
    }
    if (info.isDirectory()) {
      await removeTree(entryPath, depth + 1);
    } else if (info.isFile()) {
      await removeFile(entryPath);
    } else {
      throw new SmokeError(`refusing to delete an unsupported filesystem entry: ${entryPath}`);
    }
  }
  await rmdir(dir);
}

// ---------------------------------------------------------------------------
// Environment creation
// ---------------------------------------------------------------------------

export function yamlShelfLocation(registryPath) {
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

export function shelfMarker(shelfId) {
  return ["# Disposable smoke fixture shelf marker.", "version = 1", "type = shelf", `id = ${shelfId}`, ""].join("\n");
}

/**
 * Creates a brand-new smoke environment. It fails if `root` already exists, if
 * the host name is already registered, or if the root would land inside the
 * repository. It never overwrites anything.
 */
export async function createSmokeEnvironment({
  root,
  hostName,
  desktopHost,
  shelfName,
  repositoryRoot,
  copiedFiles = [],
  registry,
  marker = createMarker(),
  extensionKey = null,
  shelfId = randomUUID(),
  createdAt = new Date()
}) {
  assertHostName(hostName);
  const resolvedRoot = assertSafeRoot(root);

  if (repositoryRoot && (samePath(repositoryRoot, resolvedRoot) || isPathInside(repositoryRoot, resolvedRoot))) {
    throw new SmokeError("--root must be outside the repository");
  }
  if (typeof desktopHost !== "string" || !path.isAbsolute(desktopHost)) {
    throw new SmokeError("--desktop-host must be an absolute path to the built experimental collector host .js");
  }
  if (!registry || typeof registry.exists !== "function") {
    throw new SmokeError("a registry adapter is required");
  }

  const registryKey = registryKeyFor(hostName);
  if (await registry.exists(registryKey)) {
    throw new SmokeError(`a Chrome native messaging host is already registered as ${hostName}; choose another --host`);
  }

  const parent = path.dirname(resolvedRoot);
  try {
    const parentInfo = await stat(parent);
    if (!parentInfo.isDirectory()) throw new SmokeError(`parent of --root is not a directory: ${parent}`);
  } catch (error) {
    if (error instanceof SmokeError) throw error;
    throw new SmokeError(`parent of --root does not exist: ${parent}`);
  }

  try {
    await mkdir(resolvedRoot, { recursive: false });
  } catch (error) {
    if (error?.code === "EEXIST") {
      throw new SmokeError(`--root already exists: ${resolvedRoot}; choose a new empty directory`);
    }
    throw error;
  }

  const { key, id: extensionId } = extensionKey ?? createExtensionKey();

  const extensionDir = path.join(resolvedRoot, EXTENSION_DIR);
  const shelfDir = path.join(resolvedRoot, "shelf");
  const profileDir = path.join(resolvedRoot, "profile");
  const descriptorPath = path.join(resolvedRoot, DESCRIPTOR_FILE);
  const hostManifestPath = path.join(resolvedRoot, HOST_MANIFEST_FILE);
  const launcherPath = path.join(resolvedRoot, LAUNCHER_FILE);
  const shelfLocationPath = path.join(resolvedRoot, SHELF_LOCATION_FILE);
  const ownerPath = path.join(resolvedRoot, OWNER_FILE);

  try {
    await mkdir(extensionDir, { recursive: false });
    await mkdir(path.join(shelfDir, "books"), { recursive: true });
    await mkdir(path.join(shelfDir, "annotations"), { recursive: true });
    await mkdir(profileDir, { recursive: false });

    for (const file of copiedFiles) {
      await copyFile(path.join(repositoryRoot, file), path.join(extensionDir, file));
    }

    // The production manifest must stay free of nativeMessaging, host names and
    // extension identities. Only this disposable copy gains the permission.
    const manifest = JSON.parse(await readFile(path.join(repositoryRoot, "manifest.json"), "utf8"));
    manifest.permissions = Array.from(new Set([...(manifest.permissions ?? []), "nativeMessaging"]));
    manifest.key = key;
    await writeFile(path.join(extensionDir, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n", "utf8");

    await writeFile(
      path.join(shelfDir, "library.json"),
      JSON.stringify(
        { type: "library", version: "0.1", name: shelfName, booksPath: "books", annotationsPath: "annotations" },
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
        {
          experimental: true,
          shelfLocationPath,
          expectedShelfId: shelfId,
          allowedOrigin: allowedOriginFor(extensionId)
        },
        null,
        2
      ) + "\n",
      "utf8"
    );

    await writeFile(launcherPath, ["@echo off", `"${process.execPath}" "${desktopHost}" %*`, ""].join("\r\n"), "utf8");

    await writeFile(
      hostManifestPath,
      JSON.stringify(
        {
          name: hostName,
          description: hostManifestDescription(marker),
          path: launcherPath,
          type: "stdio",
          allowed_origins: [allowedOriginFor(extensionId)]
        },
        null,
        2
      ) + "\n",
      "utf8"
    );

    await writeFile(
      ownerPath,
      JSON.stringify(createOwnerRecord({ marker, hostName, extensionId, root: resolvedRoot, createdAt }), null, 2) + "\n",
      "utf8"
    );
  } catch (error) {
    throw new SmokeError(
      `could not create the smoke environment (${error instanceof Error ? error.message : String(error)}). ` +
        `A partially built directory may remain at ${resolvedRoot}; it has no ownership record, so cleanup will ` +
        "refuse it. Inspect it and remove it manually."
    );
  }

  return {
    experimental: true,
    root: resolvedRoot,
    extensionDir,
    extensionId,
    profileDir,
    shelfDir,
    expectedShelfId: shelfId,
    shelfLocationPath,
    descriptorPath,
    hostManifestPath,
    launcherPath,
    ownerPath,
    ownershipMarker: marker,
    desktopHost,
    hostName,
    registryKey,
    hostProfile: { hostName }
  };
}

// ---------------------------------------------------------------------------
// Environment removal
// ---------------------------------------------------------------------------

/**
 * Removes a smoke environment, but only after proving that the root, the
 * ownership record, the Chrome host manifest and the extension manifest all
 * describe the same run. Every check runs before anything is deleted, and a
 * symbolic link, junction or missing proof stops the whole operation.
 */
export async function removeSmokeEnvironment({ root, hostName, registry }) {
  assertHostName(hostName);
  const resolvedRoot = assertSafeRoot(root);
  if (!registry || typeof registry.read !== "function" || typeof registry.exists !== "function") {
    throw new SmokeError("a registry adapter is required");
  }

  let rootInfo;
  try {
    rootInfo = await lstat(resolvedRoot);
  } catch {
    throw new SmokeError(`${resolvedRoot} does not exist; nothing to remove`);
  }
  if (rootInfo.isSymbolicLink()) {
    throw new SmokeError(`${resolvedRoot} is a symbolic link or junction; refusing to touch it`);
  }
  if (!rootInfo.isDirectory()) {
    throw new SmokeError(`${resolvedRoot} is not a directory; refusing to touch it`);
  }

  const ownerText = await readFile(path.join(resolvedRoot, OWNER_FILE), "utf8").catch(() => null);
  if (ownerText === null) {
    throw new SmokeError(`${resolvedRoot} has no ${OWNER_FILE}; ownership cannot be proven, refusing to delete it`);
  }
  const ownerRecord = parseOwnerRecord(ownerText);

  const hostManifest = await readJsonOrNull(path.join(resolvedRoot, HOST_MANIFEST_FILE));
  const extensionManifest = await readJsonOrNull(path.join(resolvedRoot, EXTENSION_DIR, "manifest.json"));
  const registryKey = registryKeyFor(hostName);
  const registryValue = await registry.read(registryKey);

  verifyOwnership({ root: resolvedRoot, hostName, ownerRecord, hostManifest, extensionManifest, registryValue });

  const reparsePoints = await findReparsePoints(resolvedRoot);
  if (reparsePoints.length > 0) {
    throw new SmokeError(
      `refusing to delete ${resolvedRoot}: it contains a symbolic link or junction (${reparsePoints.join(", ")})`
    );
  }

  let removedRegistry = false;
  if (registryValue !== null && registryValue !== undefined) {
    await registry.remove(registryKey);
    if (await registry.exists(registryKey)) {
      throw new SmokeError(`${registryKey} is still registered after deletion; the directory was left in place`);
    }
    removedRegistry = true;
  }

  try {
    await removeTree(resolvedRoot);
  } catch (error) {
    throw new SmokeError(
      `${removedRegistry ? "removed the registration but could not" : "could not"} finish deleting ${resolvedRoot}: ` +
        `${error instanceof Error ? error.message : String(error)}. The directory may be partially removed; inspect ` +
        "it and remove the rest manually."
    );
  }

  try {
    await lstat(resolvedRoot);
    throw new SmokeError(`${resolvedRoot} still exists after deletion`);
  } catch (error) {
    if (error instanceof SmokeError) throw error;
    if (error?.code !== "ENOENT") throw error;
  }

  return { root: resolvedRoot, registryKey, removedRegistry, removedRoot: true };
}

// ---------------------------------------------------------------------------
// Windows registry adapter (injected in tests)
// ---------------------------------------------------------------------------

export function createWindowsRegistry() {
  const query = (args) => execFileSync("reg", args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });

  return {
    /** Returns the default value of the key, or null when the key does not exist. */
    read(key) {
      let output;
      try {
        output = query(["query", key, "/ve"]);
      } catch {
        return null;
      }
      const match = /REG_SZ\s+(.+)$/mu.exec(output);
      return match?.[1]?.trim() ?? "";
    },
    exists(key) {
      try {
        query(["query", key]);
        return true;
      } catch {
        return false;
      }
    },
    write(key, value) {
      execFileSync("reg", ["add", key, "/ve", "/t", "REG_SZ", "/d", value, "/f"], {
        stdio: ["ignore", "ignore", "pipe"]
      });
    },
    remove(key) {
      execFileSync("reg", ["delete", key, "/f"], { stdio: ["ignore", "ignore", "pipe"] });
    }
  };
}
