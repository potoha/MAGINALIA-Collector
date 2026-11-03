#!/usr/bin/env node
/** Read-only source / add-only backup verifier for the Private Shelf E2E. */
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { createReadStream } from "node:fs";
import { copyFile, lstat, mkdir, readdir, realpath } from "node:fs/promises";
import * as path from "node:path";

function parseArguments(argv) {
  let shelfRoot = "";
  let backupRoot = "";
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!value) throw new Error("missing argument value");
    if (flag === "--shelf-root") shelfRoot = path.resolve(value);
    else if (flag === "--backup-root") backupRoot = path.resolve(value);
    else throw new Error("unknown argument");
    index += 1;
  }
  if (!shelfRoot) throw new Error("--shelf-root is required");
  if (!backupRoot) {
    const stamp = new Date().toISOString().replace(/[-:.TZ]/gu, "").slice(0, 14);
    backupRoot = path.join(path.dirname(shelfRoot), `${path.basename(shelfRoot)}.e2e-backup-${stamp}`);
  }
  return { shelfRoot, backupRoot };
}

function samePath(left, right) {
  const a = path.resolve(left);
  const b = path.resolve(right);
  return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function isInside(parent, candidate) {
  const relative = path.relative(path.resolve(parent), path.resolve(candidate));
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

async function snapshot(root) {
  const rootInfo = await lstat(root);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) throw new Error("source root is not a regular directory");
  const canonicalRoot = await realpath(root);
  if (!samePath(canonicalRoot, root)) throw new Error("source root resolves through a reparse point");
  const entries = new Map();
  let files = 0;
  let directories = 0;

  async function walk(directory, relativeDirectory) {
    const children = await readdir(directory, { withFileTypes: true });
    children.sort((left, right) => left.name.localeCompare(right.name, "en"));
    for (const child of children) {
      const absolute = path.join(directory, child.name);
      const relative = path.posix.join(relativeDirectory.split(path.sep).join(path.posix.sep), child.name);
      const info = await lstat(absolute);
      if (info.isSymbolicLink()) throw new Error("source contains a symbolic link or junction");
      if (info.isDirectory()) {
        directories += 1;
        entries.set(relative, { kind: "directory" });
        await walk(absolute, path.join(relativeDirectory, child.name));
      } else if (info.isFile()) {
        files += 1;
        const digest = createHash("sha256");
        for await (const chunk of createReadStream(absolute)) digest.update(chunk);
        entries.set(relative, { kind: "file", size: info.size, sha256: digest.digest("hex") });
      } else {
        throw new Error("source contains an unsupported filesystem entry");
      }
    }
  }
  await walk(root, "");
  return { entries, files, directories };
}

function aggregateDigest(entries) {
  const hash = createHash("sha256");
  for (const [relative, value] of [...entries].sort(([left], [right]) => left.localeCompare(right, "en"))) {
    hash.update(relative, "utf8");
    hash.update("\0");
    hash.update(JSON.stringify(value), "utf8");
    hash.update("\n");
  }
  return hash.digest("hex");
}

async function copyTree(source, destination) {
  const before = await snapshot(source);
  await mkdir(destination, { recursive: false });
  for (const [relative, entry] of before.entries) {
    const target = path.join(destination, relative);
    if (entry.kind === "directory") await mkdir(target, { recursive: false });
    else {
      await mkdir(path.dirname(target), { recursive: true });
      await copyFile(path.join(source, relative), target, constants.COPYFILE_EXCL);
    }
  }
  const [sourceAfter, backupAfter] = await Promise.all([snapshot(source), snapshot(destination)]);
  const beforeDigest = aggregateDigest(before.entries);
  if (aggregateDigest(sourceAfter.entries) !== beforeDigest || aggregateDigest(backupAfter.entries) !== beforeDigest) {
    throw new Error("backup verification did not match the read-only source snapshot");
  }
  return { files: before.files, directories: before.directories, sha256: beforeDigest };
}

async function main() {
  const { shelfRoot, backupRoot } = parseArguments(process.argv.slice(2));
  if (samePath(shelfRoot, backupRoot) || isInside(shelfRoot, backupRoot) || isInside(backupRoot, shelfRoot)) {
    throw new Error("backup and source roots must be separate");
  }
  try { await lstat(backupRoot); throw new Error("backup destination already exists"); }
  catch (error) { if (error?.code !== "ENOENT") throw error; }
  const result = await copyTree(shelfRoot, backupRoot);
  process.stdout.write(JSON.stringify({ backupRoot, ...result }) + "\n");
}

main().catch(() => {
  process.stderr.write("backup: no verified copy was produced; inspect the new backup destination before retrying.\n");
  process.exitCode = 1;
});
