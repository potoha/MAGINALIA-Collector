#!/usr/bin/env node
/**
 * Builds the unpacked-extension distribution ZIP for GitHub Releases.
 *
 * - Ships only the explicit allow-list below; nothing is discovered by globbing.
 * - Writes dist/maginalia-collector-<version>.zip with manifest.json at the ZIP
 *   root, so the extracted folder can be chosen in 「パッケージ化されていない
 *   拡張機能を読み込む」 directly.
 * - Re-reads the written ZIP through its central directory and checks every entry
 *   against its source bytes before writing dist/SHA256SUMS.
 *
 * Node built-ins only. Text files are normalised to LF and every entry gets a
 * fixed timestamp, so the same commit produces the same ZIP on any platform.
 */
import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import * as zlib from "node:zlib";

export const SHIPPED_FILES = Object.freeze([
  "manifest.json",
  "service-worker.js",
  "host-client.js",
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
]);

const TEXT_EXTENSIONS = new Set([".json", ".js", ".html", ".css"]);
// 1980-01-01 00:00:00, the earliest DOS timestamp.
const DOS_TIME = 0;
const DOS_DATE = (0 << 9) | (1 << 5) | 1;
const UTF8_FLAG = 0x0800;
const METHOD_DEFLATE = 8;
const VERSION_NEEDED = 20;
const SIG_LOCAL = 0x04034b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_END = 0x06054b50;

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function fail(message) {
  const error = new Error(message);
  error.code = "build-dist-failed";
  throw error;
}

function crc32(buffer) {
  return zlib.crc32(buffer) >>> 0;
}

function isSafeEntryName(name) {
  return typeof name === "string"
    && name.length > 0
    && !name.startsWith("/")
    && !name.includes("\\")
    && !name.split("/").some((part) => part === "" || part === "." || part === "..");
}

async function readShippedFile(root, name) {
  if (!isSafeEntryName(name)) fail(`unsafe allow-list entry: ${name}`);
  const full = path.join(root, ...name.split("/"));
  const info = await lstat(full).catch(() => null);
  if (!info || !info.isFile() || info.isSymbolicLink()) fail(`allow-listed file is missing or not a regular file: ${name}`);
  const bytes = await readFile(full);
  if (!TEXT_EXTENSIONS.has(path.extname(name).toLowerCase())) return bytes;
  return Buffer.from(bytes.toString("utf8").replace(/\r\n/g, "\n"), "utf8");
}

/**
 * Checks that every local file the manifest and the shipped HTML pages reference
 * is in the allow-list, so a missing page or script cannot slip into a release.
 */
export function checkReferences(files) {
  const manifest = JSON.parse(files.get("manifest.json").toString("utf8"));
  const referenced = new Set();
  const add = (value) => {
    if (typeof value === "string" && value && !/^[a-z]+:/i.test(value)) referenced.add(value.split(/[?#]/)[0]);
  };
  add(manifest.background?.service_worker);
  add(manifest.action?.default_popup);
  add(manifest.action?.default_icon);
  for (const icon of Object.values(manifest.icons ?? {})) add(icon);
  for (const [name, bytes] of files) {
    if (!name.endsWith(".html")) continue;
    for (const match of bytes.toString("utf8").matchAll(/\b(?:src|href)="([^"]+)"/g)) add(match[1]);
  }
  const missing = [...referenced].filter((name) => !files.has(name));
  if (missing.length > 0) fail(`referenced but not shipped: ${missing.join(", ")}`);
  return manifest;
}

export function createZip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const { name, data } of entries) {
    const nameBytes = Buffer.from(name, "utf8");
    const compressed = zlib.deflateRawSync(data, { level: 9 });
    const crc = crc32(data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(SIG_LOCAL, 0);
    local.writeUInt16LE(VERSION_NEEDED, 4);
    local.writeUInt16LE(UTF8_FLAG, 6);
    local.writeUInt16LE(METHOD_DEFLATE, 8);
    local.writeUInt16LE(DOS_TIME, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, nameBytes, compressed);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(SIG_CENTRAL, 0);
    central.writeUInt16LE(VERSION_NEEDED, 4);
    central.writeUInt16LE(VERSION_NEEDED, 6);
    central.writeUInt16LE(UTF8_FLAG, 8);
    central.writeUInt16LE(METHOD_DEFLATE, 10);
    central.writeUInt16LE(DOS_TIME, 12);
    central.writeUInt16LE(DOS_DATE, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBytes);

    offset += local.length + nameBytes.length + compressed.length;
  }
  const centralSize = centrals.reduce((sum, part) => sum + part.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(SIG_END, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);
  return Buffer.concat([...locals, ...centrals, end]);
}

/** Reads every entry through the central directory and inflates its data. */
export function readZip(buffer) {
  const endOffset = buffer.length - 22;
  if (endOffset < 0 || buffer.readUInt32LE(endOffset) !== SIG_END) fail("ZIP end record not found (comments are not expected)");
  const count = buffer.readUInt16LE(endOffset + 10);
  const centralSize = buffer.readUInt32LE(endOffset + 12);
  let cursor = buffer.readUInt32LE(endOffset + 16);
  if (cursor + centralSize !== endOffset) fail("ZIP central directory bounds are inconsistent");
  const entries = [];
  for (let index = 0; index < count; index += 1) {
    if (buffer.readUInt32LE(cursor) !== SIG_CENTRAL) fail("ZIP central directory entry is malformed");
    const method = buffer.readUInt16LE(cursor + 10);
    const crc = buffer.readUInt32LE(cursor + 16);
    const compressedSize = buffer.readUInt32LE(cursor + 20);
    const size = buffer.readUInt32LE(cursor + 24);
    const nameLength = buffer.readUInt16LE(cursor + 28);
    const extraLength = buffer.readUInt16LE(cursor + 30);
    const commentLength = buffer.readUInt16LE(cursor + 32);
    const localOffset = buffer.readUInt32LE(cursor + 42);
    const name = buffer.subarray(cursor + 46, cursor + 46 + nameLength).toString("utf8");
    cursor += 46 + nameLength + extraLength + commentLength;

    if (buffer.readUInt32LE(localOffset) !== SIG_LOCAL) fail(`ZIP local header is malformed: ${name}`);
    const localNameLength = buffer.readUInt16LE(localOffset + 26);
    const localExtraLength = buffer.readUInt16LE(localOffset + 28);
    const localName = buffer.subarray(localOffset + 30, localOffset + 30 + localNameLength).toString("utf8");
    if (localName !== name) fail(`ZIP local and central names differ: ${name}`);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    const raw = buffer.subarray(dataStart, dataStart + compressedSize);
    let data;
    if (method === METHOD_DEFLATE) data = zlib.inflateRawSync(raw);
    else if (method === 0) data = Buffer.from(raw);
    else fail(`unsupported ZIP method for ${name}`);
    if (data.length !== size || crc32(data) !== crc) fail(`ZIP entry failed its size or CRC check: ${name}`);
    entries.push({ name, data });
  }
  return entries;
}

export function verifyZip(buffer, files) {
  const entries = readZip(buffer);
  const names = entries.map((entry) => entry.name);
  if (names[0] !== "manifest.json") fail("manifest.json is not the first ZIP entry");
  if (new Set(names).size !== names.length) fail("ZIP has duplicate entries");
  const expected = [...files.keys()].sort();
  if (JSON.stringify([...names].sort()) !== JSON.stringify(expected)) fail("ZIP entries differ from the allow-list");
  for (const { name, data } of entries) {
    if (!isSafeEntryName(name) || name.endsWith("/")) fail(`unsafe ZIP entry name: ${name}`);
    if (!data.equals(files.get(name))) fail(`ZIP entry differs from its source: ${name}`);
  }
  if (!names.includes("manifest.json") || names.some((name) => name.toLowerCase().endsWith("/manifest.json"))) {
    fail("manifest.json must exist only at the ZIP root");
  }
  return entries;
}

export async function buildDist({ root = REPO_ROOT, outDir = path.join(root, "dist") } = {}) {
  const files = new Map();
  for (const name of SHIPPED_FILES) files.set(name, await readShippedFile(root, name));
  const manifest = checkReferences(files);
  if (typeof manifest.version !== "string" || !/^\d+(?:\.\d+){0,3}$/.test(manifest.version)) fail("manifest version is invalid");
  if (typeof manifest.key !== "string" || manifest.key.length === 0) fail("manifest key is missing");

  const ordered = ["manifest.json", ...SHIPPED_FILES.filter((name) => name !== "manifest.json").sort()];
  const zip = createZip(ordered.map((name) => ({ name, data: files.get(name) })));
  verifyZip(zip, files);

  const zipName = `maginalia-collector-${manifest.version}.zip`;
  await mkdir(outDir, { recursive: true });
  const zipPath = path.join(outDir, zipName);
  const temporary = `${zipPath}.tmp-${process.pid}`;
  await writeFile(temporary, zip);
  await rename(temporary, zipPath);

  const written = await readFile(zipPath);
  verifyZip(written, files);
  const sha256 = createHash("sha256").update(written).digest("hex");
  const sumsPath = path.join(outDir, "SHA256SUMS");
  await writeFile(sumsPath, `${sha256}  ${zipName}\n`, "utf8");
  return { zipPath, sumsPath, zipName, sha256, version: manifest.version, files: ordered, bytes: written.length };
}

async function main() {
  const result = await buildDist();
  process.stdout.write([
    `zip: dist/${result.zipName} (${result.bytes} bytes, ${result.files.length} files)`,
    `sha256: ${result.sha256}`,
    ...result.files.map((name) => `  ${name}`),
    ""
  ].join("\n"));
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => {
    process.stderr.write(`build-dist: ${error.message}\n`);
    process.exitCode = 1;
  });
}
