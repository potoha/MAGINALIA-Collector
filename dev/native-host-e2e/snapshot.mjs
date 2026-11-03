#!/usr/bin/env node
/** Create a content-hash inventory without exposing Shelf record contents. */
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, mkdir, readdir, realpath, writeFile } from "node:fs/promises";
import * as path from "node:path";

function parseArguments(argv) {
  let shelfRoot = "";
  let output = "";
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!value) throw new Error("missing argument value");
    if (flag === "--shelf-root") shelfRoot = path.resolve(value);
    else if (flag === "--output") output = path.resolve(value);
    else throw new Error("unknown argument");
    index += 1;
  }
  if (!shelfRoot || !output) throw new Error("--shelf-root and --output are required");
  return { shelfRoot, output };
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

async function snapshotTree(root) {
  const rootInfo = await lstat(root);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink() || !samePath(await realpath(root), root)) {
    throw new Error("Shelf root is unsafe");
  }
  const files = [];
  async function walk(directory, relativeDirectory) {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name, "en"));
    for (const entry of entries) {
      const absolute = path.join(directory, entry.name);
      const relative = path.posix.join(relativeDirectory, entry.name);
      const info = await lstat(absolute);
      if (info.isSymbolicLink()) throw new Error("Shelf contains a link or reparse point");
      if (info.isDirectory()) await walk(absolute, relative);
      else if (info.isFile()) {
        const digest = createHash("sha256");
        for await (const chunk of createReadStream(absolute)) digest.update(chunk);
        files.push({ path: relative, size: info.size, sha256: digest.digest("hex") });
      } else throw new Error("Shelf contains an unsupported entry");
    }
  }
  await walk(root, "");
  const hash = createHash("sha256");
  for (const entry of files) hash.update(`${entry.path}\0${entry.size}\0${entry.sha256}\n`, "utf8");
  return { version: 1, files, fileCount: files.length, sha256: hash.digest("hex") };
}

async function main() {
  const { shelfRoot, output } = parseArguments(process.argv.slice(2));
  if (samePath(shelfRoot, output) || isInside(shelfRoot, output) || isInside(output, shelfRoot)) {
    throw new Error("snapshot output must be outside the Shelf");
  }
  try { await lstat(output); throw new Error("snapshot output already exists"); }
  catch (error) { if (error?.code !== "ENOENT") throw error; }
  await mkdir(path.dirname(output), { recursive: true });
  const snapshot = await snapshotTree(shelfRoot);
  await writeFile(output, JSON.stringify(snapshot, null, 2) + "\n", { encoding: "utf8", flag: "wx" });
  process.stdout.write(JSON.stringify({ snapshotPath: output, fileCount: snapshot.fileCount, sha256: snapshot.sha256 }) + "\n");
}

main().catch(() => {
  process.stderr.write("snapshot: no Shelf inventory was produced; source data was left untouched.\n");
  process.exitCode = 1;
});
