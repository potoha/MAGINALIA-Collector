const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { pathToFileURL } = require("node:url");
const zlib = require("node:zlib");

const ROOT = path.join(__dirname, "..");
const loadBuilder = () => import(pathToFileURL(path.join(ROOT, "scripts", "build-dist.mjs")).href);
const EXPECTED_FILES = [
  "manifest.json", "service-worker.js", "host-client.js", "outbox.js",
  "popup.html", "popup.css", "popup.js",
  "capture.html", "capture.css", "capture.js",
  "onboarding.html", "onboarding.css", "onboarding.js",
  "icon..png"
];

// A deliberately separate, minimal reader: walk the central directory from the
// end record and inflate each entry from its local header.
function listZip(buffer) {
  const end = buffer.length - 22;
  assert.equal(buffer.readUInt32LE(end), 0x06054b50);
  const count = buffer.readUInt16LE(end + 10);
  let cursor = buffer.readUInt32LE(end + 16);
  const entries = [];
  for (let index = 0; index < count; index += 1) {
    assert.equal(buffer.readUInt32LE(cursor), 0x02014b50);
    const compressedSize = buffer.readUInt32LE(cursor + 20);
    const nameLength = buffer.readUInt16LE(cursor + 28);
    const skip = buffer.readUInt16LE(cursor + 30) + buffer.readUInt16LE(cursor + 32);
    const localOffset = buffer.readUInt32LE(cursor + 42);
    const name = buffer.toString("utf8", cursor + 46, cursor + 46 + nameLength);
    const dataStart = localOffset + 30 + buffer.readUInt16LE(localOffset + 26) + buffer.readUInt16LE(localOffset + 28);
    entries.push({ name, data: zlib.inflateRawSync(buffer.subarray(dataStart, dataStart + compressedSize)) });
    cursor += 46 + nameLength + skip;
  }
  return entries;
}

function tempDir(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "collector-dist-test-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

test("the distribution ZIP contains exactly the allow-list with manifest.json at the root", async (t) => {
  const { buildDist } = await loadBuilder();
  const outDir = tempDir(t);
  const result = await buildDist({ outDir });
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, "manifest.json"), "utf8"));

  assert.equal(result.zipName, `maginalia-collector-${manifest.version}.zip`);
  const entries = listZip(fs.readFileSync(result.zipPath));
  const names = entries.map((entry) => entry.name);
  assert.equal(names[0], "manifest.json");
  assert.deepEqual([...names].sort(), [...EXPECTED_FILES].sort());
  assert.equal(names.some((name) => name.includes("/") || name.includes("\\")), false);

  const zippedManifest = JSON.parse(entries[0].data.toString("utf8"));
  assert.equal(zippedManifest.version, manifest.version);
  assert.equal(zippedManifest.key, manifest.key);
  for (const { name, data } of entries) {
    const source = fs.readFileSync(path.join(ROOT, name));
    const expected = name.endsWith(".png") ? source : Buffer.from(source.toString("utf8").replace(/\r\n/g, "\n"));
    assert.ok(data.equals(expected), name);
  }
});

test("SHA256SUMS names the ZIP with its real digest and repeated builds are identical", async (t) => {
  const { buildDist } = await loadBuilder();
  const first = await buildDist({ outDir: tempDir(t) });
  const second = await buildDist({ outDir: tempDir(t) });

  const digest = crypto.createHash("sha256").update(fs.readFileSync(first.zipPath)).digest("hex");
  assert.equal(fs.readFileSync(first.sumsPath, "utf8"), `${digest}  ${first.zipName}\n`);
  assert.equal(first.sha256, digest);
  assert.equal(second.sha256, first.sha256);
});

test("the allow-list matches the extension files at the repository root", async () => {
  const { SHIPPED_FILES } = await loadBuilder();
  assert.deepEqual([...SHIPPED_FILES].sort(), [...EXPECTED_FILES].sort());
  const rootFiles = fs.readdirSync(ROOT, { withFileTypes: true })
    .filter((entry) => entry.isFile() && /\.(js|html|css|png|json)$/i.test(entry.name))
    .map((entry) => entry.name)
    .sort();
  assert.deepEqual(rootFiles, [...EXPECTED_FILES].sort());
});

test("a page or script referenced but not shipped stops the build", async () => {
  const { checkReferences } = await loadBuilder();
  const files = new Map([
    ["manifest.json", fs.readFileSync(path.join(ROOT, "manifest.json"))],
    ["capture.html", fs.readFileSync(path.join(ROOT, "capture.html"))]
  ]);
  assert.throws(() => checkReferences(files), /referenced but not shipped/);
});

test("verification rejects an extra entry, a nested manifest, or changed bytes", async () => {
  const { createZip, verifyZip } = await loadBuilder();
  const files = new Map([["manifest.json", Buffer.from("{}")], ["a.js", Buffer.from("a")]]);
  const zip = (entries) => createZip(entries.map(([name, data]) => ({ name, data: Buffer.from(data) })));

  assert.doesNotThrow(() => verifyZip(zip([["manifest.json", "{}"], ["a.js", "a"]]), files));
  assert.throws(() => verifyZip(zip([["manifest.json", "{}"], ["a.js", "a"], ["b.js", "b"]]), files), /allow-list/);
  assert.throws(() => verifyZip(zip([["extension/manifest.json", "{}"], ["a.js", "a"]]), files), /first ZIP entry/);
  assert.throws(() => verifyZip(zip([["manifest.json", "{}"], ["a.js", "changed"]]), files), /differs/);
});

test("dist/ is ignored by Git", () => {
  const ignore = fs.readFileSync(path.join(ROOT, ".gitignore"), "utf8").split(/\r?\n/);
  assert.ok(ignore.includes("dist/"));
});
