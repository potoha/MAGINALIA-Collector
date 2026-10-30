const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { pathToFileURL } = require("node:url");

// The harness core is ESM, so it is loaded through a dynamic import. `lib` is
// cached after the first successful import; the RSA key is generated once.
const REPOSITORY_ROOT = path.resolve(__dirname, "..");
const LIB_URL = pathToFileURL(path.join(REPOSITORY_ROOT, "dev", "native-host-smoke", "lib.mjs")).href;
const DESKTOP_HOST = "C:\\smoke\\collector-native-host.js";
const HOST_NAME = "org.maginalia.nhs_test";

let lib;
const getLib = async () => (lib ??= await import(LIB_URL));
const extensionKey = getLib().then((module) => module.createExtensionKey());

function createFakeRegistry(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    values,
    read(key) {
      return values.has(key) ? values.get(key) : null;
    },
    exists(key) {
      return values.has(key);
    },
    write(key, value) {
      values.set(key, value);
    },
    remove(key) {
      values.delete(key);
    }
  };
}

function createWorkspace(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mag-nhs-test-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// `createSmokeEnvironment` requires the parent of --root to exist, so every
// environment lives at <workspace>/<label>/env.
function prepareCaseDir(workspace, label) {
  const caseDir = path.join(workspace, label);
  fs.mkdirSync(caseDir, { recursive: true });
  return caseDir;
}

async function createEnvironment(workspace, { label = "case", hostName = HOST_NAME, registry, rootName = "env" } = {}) {
  const { createSmokeEnvironment } = await getLib();
  const caseDir = prepareCaseDir(workspace, label);
  const root = path.join(caseDir, rootName);
  const adapter = registry ?? createFakeRegistry();
  const environment = await createSmokeEnvironment({
    root,
    hostName,
    desktopHost: DESKTOP_HOST,
    shelfName: "Smoke Shelf",
    repositoryRoot: REPOSITORY_ROOT,
    copiedFiles: [],
    registry: adapter,
    extensionKey: await extensionKey,
    createdAt: "2026-01-01T00:00:00.000Z"
  });
  return { environment, root, hostName, registry: adapter, caseDir };
}

async function rejectsSmoke(promise, pattern) {
  await assert.rejects(promise, (error) => {
    assert.equal(error.name, "SmokeError");
    assert.match(error.message, pattern);
    return true;
  });
}

test("happy path: setup, register, remove deletes only the environment", async (t) => {
  const workspace = createWorkspace(t);
  const sentinel = path.join(workspace, "keep.txt");
  fs.writeFileSync(sentinel, "outside the smoke environment\n", "utf8");

  const { environment, registry } = await createEnvironment(workspace);
  const { removeSmokeEnvironment } = await getLib();

  registry.write(environment.registryKey, environment.hostManifestPath);
  assert.equal(registry.read(environment.registryKey), environment.hostManifestPath);

  const result = await removeSmokeEnvironment({
    root: environment.root,
    hostName: environment.hostName,
    registry
  });

  assert.equal(result.removedRegistry, true);
  assert.equal(result.removedRoot, true);
  assert.equal(result.registryKey, environment.registryKey);
  assert.equal(registry.exists(environment.registryKey), false);
  assert.equal(registry.read(environment.registryKey), null);
  assert.equal(fs.existsSync(environment.root), false);
  assert.equal(fs.readFileSync(sentinel, "utf8"), "outside the smoke environment\n");
});

test("setup refuses an --root that already exists and leaves its contents alone", async (t) => {
  const workspace = createWorkspace(t);
  const { createSmokeEnvironment } = await getLib();
  const caseDir = prepareCaseDir(workspace, "case");
  const root = path.join(caseDir, "env");
  fs.mkdirSync(root);
  const sentinel = path.join(root, "precious.txt");
  fs.writeFileSync(sentinel, "do not overwrite me\n", "utf8");

  await rejectsSmoke(
    createSmokeEnvironment({
      root,
      hostName: HOST_NAME,
      desktopHost: DESKTOP_HOST,
      shelfName: "Smoke Shelf",
      repositoryRoot: REPOSITORY_ROOT,
      copiedFiles: [],
      registry: createFakeRegistry(),
      extensionKey: await extensionKey
    }),
    /already exists/i
  );

  assert.equal(fs.readFileSync(sentinel, "utf8"), "do not overwrite me\n");
  assert.equal(fs.existsSync(path.join(root, "native-host.json")), false);
  assert.equal(fs.existsSync(path.join(root, "smoke-owner.json")), false);
  assert.deepEqual(fs.readdirSync(root), ["precious.txt"]);
});

test("setup refuses a host name that is already registered", async (t) => {
  const workspace = createWorkspace(t);
  const { createSmokeEnvironment, registryKeyFor } = await getLib();
  const caseDir = prepareCaseDir(workspace, "case");
  const root = path.join(caseDir, "env");
  const registry = createFakeRegistry();
  const existingValue = "C:\\somewhere\\else\\native-host.json";
  registry.write(registryKeyFor(HOST_NAME), existingValue);

  await rejectsSmoke(
    createSmokeEnvironment({
      root,
      hostName: HOST_NAME,
      desktopHost: DESKTOP_HOST,
      shelfName: "Smoke Shelf",
      repositoryRoot: REPOSITORY_ROOT,
      copiedFiles: [],
      registry,
      extensionKey: await extensionKey
    }),
    /already registered/i
  );

  assert.equal(fs.existsSync(root), false);
  assert.equal(registry.read(registryKeyFor(HOST_NAME)), existingValue);
});

test("cleanup refuses a host manifest without the ownership marker", async (t) => {
  const workspace = createWorkspace(t);
  const { environment, registry } = await createEnvironment(workspace);
  const { removeSmokeEnvironment } = await getLib();

  registry.write(environment.registryKey, environment.hostManifestPath);
  const manifest = JSON.parse(fs.readFileSync(environment.hostManifestPath, "utf8"));
  assert.match(manifest.description, /\[smoke-marker:[0-9a-f]{32}\]/u);
  manifest.description = "Disposable MAGINALIA Collector smoke host";
  fs.writeFileSync(environment.hostManifestPath, JSON.stringify(manifest, null, 2) + "\n", "utf8");

  await rejectsSmoke(
    removeSmokeEnvironment({ root: environment.root, hostName: environment.hostName, registry }),
    /marker|ownership/i
  );

  assert.equal(registry.exists(environment.registryKey), true);
  assert.equal(registry.read(environment.registryKey), environment.hostManifestPath);
  assert.equal(fs.existsSync(environment.root), true);
});

test("cleanup refuses when the registration points at another environment", async (t) => {
  const workspace = createWorkspace(t);
  const registry = createFakeRegistry();
  const alpha = await createEnvironment(workspace, {
    label: "alpha",
    hostName: "org.maginalia.nhs_alpha",
    registry
  });
  const beta = await createEnvironment(workspace, {
    label: "beta",
    hostName: "org.maginalia.nhs_beta",
    registry
  });
  const { removeSmokeEnvironment } = await getLib();

  registry.write(alpha.environment.registryKey, beta.environment.hostManifestPath);

  await rejectsSmoke(
    removeSmokeEnvironment({ root: alpha.root, hostName: alpha.hostName, registry }),
    /points at/i
  );

  assert.equal(registry.read(alpha.environment.registryKey), beta.environment.hostManifestPath);
  assert.equal(fs.existsSync(alpha.root), true);
  assert.equal(fs.existsSync(beta.root), true);
  assert.equal(fs.existsSync(beta.environment.hostManifestPath), true);
});

test("cleanup refuses a copied root whose ownership record names another path", async (t) => {
  const workspace = createWorkspace(t);
  const { environment, registry } = await createEnvironment(workspace);
  const { removeSmokeEnvironment } = await getLib();

  registry.write(environment.registryKey, environment.hostManifestPath);

  const movedRoot = path.join(environment.root, "..", "moved");
  fs.cpSync(environment.root, movedRoot, { recursive: true });

  await rejectsSmoke(
    removeSmokeEnvironment({ root: movedRoot, hostName: environment.hostName, registry }),
    /ownership record belongs to/i
  );

  assert.equal(fs.existsSync(movedRoot), true);
  assert.equal(fs.existsSync(path.join(movedRoot, "smoke-owner.json")), true);
  assert.equal(fs.existsSync(environment.root), true);
});

test("cleanup refuses a root that contains a junction", async (t) => {
  const workspace = createWorkspace(t);
  const { environment, registry } = await createEnvironment(workspace);
  const { removeSmokeEnvironment } = await getLib();

  registry.write(environment.registryKey, environment.hostManifestPath);

  const outsideDir = path.join(workspace, "outside");
  fs.mkdirSync(outsideDir);
  fs.writeFileSync(path.join(outsideDir, "keep.txt"), "outside\n", "utf8");
  const linkPath = path.join(environment.root, "link");

  try {
    fs.symlinkSync(outsideDir, linkPath, "junction");
  } catch (error) {
    if (error?.code === "EPERM" || error?.code === "EACCES" || error?.code === "ENOTSUP") {
      t.skip(`junction creation is not permitted here (${error.code})`);
      return;
    }
    throw error;
  }

  assert.equal(fs.lstatSync(linkPath).isSymbolicLink(), true);

  await rejectsSmoke(
    removeSmokeEnvironment({ root: environment.root, hostName: environment.hostName, registry }),
    /symbolic link|junction/i
  );

  assert.equal(fs.lstatSync(linkPath).isSymbolicLink(), true);
  assert.equal(fs.statSync(outsideDir).isDirectory(), true);
  assert.equal(fs.readFileSync(path.join(outsideDir, "keep.txt"), "utf8"), "outside\n");
  assert.equal(fs.existsSync(environment.root), true);
});

test("cleanup removes the tree when the registration is already gone", async (t) => {
  const workspace = createWorkspace(t);
  const { environment, registry } = await createEnvironment(workspace);
  const { removeSmokeEnvironment } = await getLib();

  assert.equal(registry.exists(environment.registryKey), false);

  const result = await removeSmokeEnvironment({
    root: environment.root,
    hostName: environment.hostName,
    registry
  });

  assert.equal(result.removedRegistry, false);
  assert.equal(result.removedRoot, true);
  assert.equal(fs.existsSync(environment.root), false);
  assert.equal(registry.exists(environment.registryKey), false);
});

test("cleanup refuses a root without the ownership record", async (t) => {
  const workspace = createWorkspace(t);
  const { environment, registry, root } = await createEnvironment(workspace);
  const { removeSmokeEnvironment } = await getLib();

  registry.write(environment.registryKey, environment.hostManifestPath);
  fs.rmSync(path.join(root, "smoke-owner.json"));

  await rejectsSmoke(
    removeSmokeEnvironment({ root, hostName: environment.hostName, registry }),
    /ownership cannot be proven|smoke-owner/i
  );

  assert.equal(fs.existsSync(root), true);
  assert.equal(registry.read(environment.registryKey), environment.hostManifestPath);
});

test("cleanup refuses a missing root", async (t) => {
  const workspace = createWorkspace(t);
  const { removeSmokeEnvironment } = await getLib();
  const root = path.join(workspace, "absent", "env");

  assert.equal(fs.existsSync(root), false);

  await rejectsSmoke(
    removeSmokeEnvironment({ root, hostName: HOST_NAME, registry: createFakeRegistry() }),
    /does not exist/i
  );

  assert.equal(fs.existsSync(root), false);
});
