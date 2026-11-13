const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const ROOT = path.join(__dirname, "..");
const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, "manifest.json"), "utf8"));
const EXPECTED_EXTENSION_ID = "blgmoddncpknfnikdfnjelmdmphfgknf";

// Chrome derives an extension ID from the SHA-256 of the DER public key: the first
// 32 hex digits, each mapped from 0-f to a-p.
function extensionIdFromKey(base64Key) {
  const der = Buffer.from(base64Key, "base64");
  const hex = crypto.createHash("sha256").update(der).digest("hex").slice(0, 32);
  return Array.from(hex, (digit) => String.fromCharCode(97 + parseInt(digit, 16))).join("");
}

test("the fixed manifest key derives the extension ID the Host allows", () => {
  assert.equal(typeof manifest.key, "string");
  assert.equal(extensionIdFromKey(manifest.key), EXPECTED_EXTENSION_ID);
});

test("the manifest key is a 2048-bit RSA public key in SPKI DER form", () => {
  const publicKey = crypto.createPublicKey({ key: Buffer.from(manifest.key, "base64"), format: "der", type: "spki" });
  assert.equal(publicKey.type, "public");
  assert.equal(publicKey.asymmetricKeyType, "rsa");
  assert.equal(publicKey.asymmetricKeyDetails.modulusLength, 2048);
});

test("the manifest requests Native Messaging and describes the save path", () => {
  assert.equal(manifest.manifest_version, 3);
  assert.equal(manifest.version, "0.3.0");
  assert.deepEqual(
    [...manifest.permissions].sort(),
    ["activeTab", "contextMenus", "nativeMessaging", "scripting", "storage"]
  );
  assert.equal(Object.hasOwn(manifest, "host_permissions"), false);
  assert.ok(manifest.description.length <= 132);
  assert.doesNotMatch(manifest.description, /未実装/);
  assert.doesNotMatch(manifest.action.default_title, /準備中/);
});

test("no private key material is committed alongside the public key", () => {
  const skipped = new Set([".git", "node_modules", "dist"]);
  const offenders = [];
  const visit = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (skipped.has(entry.name)) continue;
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        visit(full);
      } else if (entry.isFile()) {
        if (/\.(pem|key|crx)$/i.test(entry.name)) offenders.push(entry.name);
        const text = fs.readFileSync(full, "latin1");
        if (/-----BEGIN (?:RSA |ENCRYPTED )?PRIVATE KEY-----/.test(text)) offenders.push(entry.name);
      }
    }
  };
  visit(ROOT);
  assert.deepEqual(offenders, []);
});
