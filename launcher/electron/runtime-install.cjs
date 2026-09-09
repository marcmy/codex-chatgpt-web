const { createHash } = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { renameAtomicFile, writePrivateFileAtomic } = require("./atomic-file.cjs");
const { runtimeBundlePaths } = require("./runtime-command.cjs");

const DEFAULT_SOURCE_WAIT_TIMEOUT_MS = 30_000;
const DEFAULT_SOURCE_WAIT_INTERVAL_MS = 50;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const VALIDATION_STAMP_SCHEMA_VERSION = 1;
const TRANSIENT_WINDOWS_CLEANUP_ERRORS = new Set(["EBUSY", "EPERM", "EACCES", "ENOTEMPTY"]);
const packagedSourceMetadata = new Map();
const packagedInstalledMetadata = new Map();

function removeCommittedPreviousRuntime(
  directory,
  {
    platform = process.platform,
    remove = fs.rmSync,
  } = {},
) {
  try {
    remove(directory, {
      recursive: true,
      force: true,
      ...(platform === "win32" ? { maxRetries: 8, retryDelay: 100 } : {}),
    });
    return true;
  } catch (error) {
    if (platform === "win32" && TRANSIENT_WINDOWS_CLEANUP_ERRORS.has(error?.code)) return false;
    throw error;
  }
}

function comparePaths(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function bundleIdFor(files) {
  const digest = createHash("sha256");
  for (const file of files) {
    digest.update(file.path);
    digest.update("\0");
    digest.update(String(file.size));
    digest.update("\0");
    digest.update(file.sha256);
    digest.update("\0");
  }
  return digest.digest("hex");
}

function validateManifestPath(relativePath) {
  if (typeof relativePath !== "string"
    || relativePath.length === 0
    || relativePath === "manifest.json"
    || relativePath.includes("\\")
    || path.posix.isAbsolute(relativePath)
    || path.posix.normalize(relativePath) !== relativePath
    || relativePath.split("/").some(segment => segment.length === 0 || segment === "." || segment === "..")) {
    throw new Error(`Runtime manifest contains an unsafe file path: ${JSON.stringify(relativePath)}`);
  }
  return relativePath;
}

function readRuntimeManifest(runtimeRoot, { version, platform, arch, bundleId }) {
  const manifestPath = path.join(runtimeRoot, "manifest.json");
  if (!fs.existsSync(manifestPath)) throw new Error(`Runtime manifest is missing: ${manifestPath}`);
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  } catch (error) {
    throw new Error(
      `Runtime manifest is invalid: ${manifestPath}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const expectedLauncher = `bin/${platform === "win32" ? "codex-chatgpt-web.cmd" : "codex-chatgpt-web"}`;
  if (manifest?.schemaVersion !== 2
    || manifest.appVersion !== version
    || manifest.platform !== platform
    || manifest.arch !== arch
    || manifest.launcher !== expectedLauncher
    || manifest.entrypoint !== "app/cli.js"
    || typeof manifest.bunVersion !== "string"
    || typeof manifest.playwright !== "string"
    || !SHA256_PATTERN.test(manifest.bundleId)
    || (bundleId && manifest.bundleId !== bundleId)
    || !Array.isArray(manifest.files)
    || manifest.files.length === 0) {
    const received = manifest && typeof manifest === "object" ? {
      schemaVersion: manifest.schemaVersion,
      appVersion: manifest.appVersion,
      bundleId: manifest.bundleId,
      bunVersion: manifest.bunVersion,
      platform: manifest.platform,
      arch: manifest.arch,
      launcher: manifest.launcher,
      entrypoint: manifest.entrypoint,
      playwright: manifest.playwright,
      fileCount: Array.isArray(manifest.files) ? manifest.files.length : null,
    } : manifest;
    throw new Error(
      `Runtime bundle identity mismatch: expected ${version} ${platform}/${arch}, received ${JSON.stringify(received)}`,
    );
  }

  let previousPath = null;
  const files = manifest.files.map((file, index) => {
    if (!file || typeof file !== "object"
      || !Number.isSafeInteger(file.size)
      || file.size < 0
      || !SHA256_PATTERN.test(file.sha256)) {
      throw new Error(`Runtime manifest contains an invalid file record at index ${index}`);
    }
    const relativePath = validateManifestPath(file.path);
    if (previousPath !== null && comparePaths(previousPath, relativePath) >= 0) {
      throw new Error(`Runtime manifest file paths are not unique and sorted: ${relativePath}`);
    }
    previousPath = relativePath;
    return { path: relativePath, size: file.size, sha256: file.sha256 };
  });
  if (bundleIdFor(files) !== manifest.bundleId) {
    throw new Error(`Runtime manifest bundleId does not match its file records: ${manifestPath}`);
  }
  return { ...manifest, files };
}

function runtimeFilePaths(runtimeRoot) {
  const paths = [];
  const visit = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((left, right) => comparePaths(left.name, right.name))) {
      const absolutePath = path.join(directory, entry.name);
      const relativePath = path.relative(runtimeRoot, absolutePath).split(path.sep).join("/");
      if (relativePath === "manifest.json") continue;
      if (entry.isDirectory()) {
        visit(absolutePath);
        continue;
      }
      paths.push(relativePath);
    }
  };
  visit(runtimeRoot);
  return paths.sort(comparePaths);
}

function validateRuntimeFile(runtimeRoot, canonicalRoot, file) {
  const absolutePath = path.join(runtimeRoot, ...file.path.split("/"));
  let metadata;
  try {
    metadata = fs.statSync(absolutePath);
  } catch {
    throw new Error(`Runtime bundle file is missing: ${absolutePath}`);
  }
  if (!metadata.isFile()) throw new Error(`Runtime bundle entry is not a file: ${absolutePath}`);
  if (fs.lstatSync(absolutePath).isSymbolicLink()) {
    const target = fs.realpathSync(absolutePath);
    if (target !== canonicalRoot && !target.startsWith(`${canonicalRoot}${path.sep}`)) {
      throw new Error(`Runtime bundle symlink escapes the bundle: ${absolutePath}`);
    }
  }
  if (metadata.size !== file.size) {
    throw new Error(`Runtime bundle file size mismatch: ${absolutePath}`);
  }
  const sha256 = createHash("sha256").update(fs.readFileSync(absolutePath)).digest("hex");
  if (sha256 !== file.sha256) {
    throw new Error(`Runtime bundle file checksum mismatch: ${absolutePath}`);
  }
}

function inspectRuntimeBundle(runtimeRoot, identity) {
  const manifest = readRuntimeManifest(runtimeRoot, identity);
  const expectedPaths = manifest.files.map(file => file.path);
  const expectedSet = new Set(expectedPaths);
  const paths = runtimeBundlePaths(runtimeRoot, identity.platform);
  for (const required of [
    paths.executable,
    paths.entrypoint,
    path.join(runtimeRoot, "app", "browser-helper.cjs"),
    path.join(runtimeRoot, ...manifest.launcher.split("/")),
  ]) {
    const relativePath = path.relative(runtimeRoot, required).split(path.sep).join("/");
    if (!expectedSet.has(relativePath)) {
      throw new Error(`Runtime manifest does not declare required file: ${required}`);
    }
  }

  const actualPaths = runtimeFilePaths(runtimeRoot);
  const actualSet = new Set(actualPaths);
  const missing = expectedPaths.find(relativePath => !actualSet.has(relativePath));
  if (missing) throw new Error(`Runtime bundle file is missing: ${path.join(runtimeRoot, ...missing.split("/"))}`);
  const unexpected = actualPaths.find(relativePath => !expectedSet.has(relativePath));
  if (unexpected) {
    throw new Error(`Runtime bundle contains an unmanifested file: ${path.join(runtimeRoot, ...unexpected.split("/"))}`);
  }
  if (actualPaths.length !== expectedPaths.length) {
    throw new Error(`Runtime bundle file count mismatch: expected ${expectedPaths.length}, received ${actualPaths.length}`);
  }

  const canonicalRoot = fs.realpathSync(runtimeRoot);
  for (const file of manifest.files) validateRuntimeFile(runtimeRoot, canonicalRoot, file);
  if (identity.platform !== "win32" && (fs.statSync(paths.executable).mode & 0o111) === 0) {
    throw new Error(`Bundled Bun runtime is not executable: ${paths.executable}`);
  }
  return { manifest, runtimeRoot: paths.runtimeRoot };
}

function validateRuntimeBundle(runtimeRoot, identity) {
  return inspectRuntimeBundle(runtimeRoot, identity).runtimeRoot;
}

function runtimeValidationStampPath(coreHome, identity, kind) {
  return path.join(
    coreHome,
    "validation",
    `${identity.version}-${identity.platform}-${identity.arch}-${kind}.json`,
  );
}

function runtimeMetadataDigest(runtimeRoot, manifest) {
  const expectedPaths = manifest.files.map(file => file.path);
  const expectedSet = new Set(expectedPaths);
  const actualPaths = runtimeFilePaths(runtimeRoot);
  const actualSet = new Set(actualPaths);
  const missing = expectedPaths.find(relativePath => !actualSet.has(relativePath));
  if (missing) throw new Error(`Runtime bundle file is missing: ${path.join(runtimeRoot, ...missing.split("/"))}`);
  const unexpected = actualPaths.find(relativePath => !expectedSet.has(relativePath));
  if (unexpected) {
    throw new Error(`Runtime bundle contains an unmanifested file: ${path.join(runtimeRoot, ...unexpected.split("/"))}`);
  }
  if (actualPaths.length !== expectedPaths.length) {
    throw new Error(`Runtime bundle file count mismatch: expected ${expectedPaths.length}, received ${actualPaths.length}`);
  }

  const canonicalRoot = fs.realpathSync(runtimeRoot);
  const digest = createHash("sha256");
  for (const file of manifest.files) {
    const absolutePath = path.join(runtimeRoot, ...file.path.split("/"));
    let linkMetadata;
    try {
      linkMetadata = fs.lstatSync(absolutePath, { bigint: true });
    } catch {
      throw new Error(`Runtime bundle file is missing: ${absolutePath}`);
    }
    let metadata = linkMetadata;
    let type = "file";
    let target = "";
    if (linkMetadata.isSymbolicLink()) {
      type = "symlink";
      const canonicalTarget = fs.realpathSync(absolutePath);
      if (canonicalTarget !== canonicalRoot && !canonicalTarget.startsWith(`${canonicalRoot}${path.sep}`)) {
        throw new Error(`Runtime bundle symlink escapes the bundle: ${absolutePath}`);
      }
      metadata = fs.statSync(absolutePath, { bigint: true });
      target = path.relative(canonicalRoot, canonicalTarget).split(path.sep).join("/");
    }
    if (!metadata.isFile()) throw new Error(`Runtime bundle entry is not a file: ${absolutePath}`);
    if (metadata.size !== BigInt(file.size)) {
      throw new Error(`Runtime bundle file size mismatch: ${absolutePath}`);
    }
    digest.update(file.path);
    digest.update("\0");
    digest.update(String(metadata.size));
    digest.update("\0");
    digest.update(String(metadata.mtimeNs));
    digest.update("\0");
    digest.update(String(metadata.ctimeNs));
    digest.update("\0");
    digest.update(type);
    digest.update("\0");
    digest.update(target);
    digest.update("\0");
  }
  return digest.digest("hex");
}

function inspectRuntimeManifest(runtimeRoot, identity) {
  const manifest = readRuntimeManifest(runtimeRoot, identity);
  const paths = runtimeBundlePaths(runtimeRoot, identity.platform);
  const expectedSet = new Set(manifest.files.map(file => file.path));
  for (const required of [
    paths.executable,
    paths.entrypoint,
    path.join(runtimeRoot, "app", "browser-helper.cjs"),
    path.join(runtimeRoot, ...manifest.launcher.split("/")),
  ]) {
    const relativePath = path.relative(runtimeRoot, required).split(path.sep).join("/");
    if (!expectedSet.has(relativePath)) {
      throw new Error(`Runtime manifest does not declare required file: ${required}`);
    }
  }
  return { manifest, runtimeRoot: paths.runtimeRoot };
}

function validatePackagedBrowserHelper(source, manifest) {
  const relativePath = "app/browser-helper.cjs";
  const file = manifest.files.find(candidate => candidate.path === relativePath);
  if (!file) throw new Error(`Runtime manifest does not declare required file: ${path.join(source, "app", "browser-helper.cjs")}`);
  validateRuntimeFile(source, fs.realpathSync(source), file);
}

function inspectRuntimeMetadata(runtimeRoot, identity) {
  const inspected = inspectRuntimeManifest(runtimeRoot, identity);
  return {
    ...inspected,
    metadataDigest: runtimeMetadataDigest(runtimeRoot, inspected.manifest),
  };
}

function packagedSourceMetadataKey(source, identity) {
  return `${path.resolve(source)}\0${identity.version}\0${identity.platform}\0${identity.arch}`;
}

function packagedInstalledMetadataKey(destination, identity) {
  return `${path.resolve(destination)}\0${identity.bundleId}`;
}

function readValidationStamp(stampPath) {
  try {
    const stamp = JSON.parse(fs.readFileSync(stampPath, "utf8"));
    if (stamp?.schemaVersion !== VALIDATION_STAMP_SCHEMA_VERSION
      || !SHA256_PATTERN.test(stamp.bundleId)
      || !SHA256_PATTERN.test(stamp.metadataDigest)) return null;
    return stamp;
  } catch {
    return null;
  }
}

function writeValidationStamp(stampPath, manifest, metadataDigest) {
  try {
    writePrivateFileAtomic(stampPath, `${JSON.stringify({
      schemaVersion: VALIDATION_STAMP_SCHEMA_VERSION,
      bundleId: manifest.bundleId,
      metadataDigest,
    })}\n`);
  } catch {
    // Validation stamps are only a startup optimization. If they cannot be persisted, the next
    // launch falls back to a complete content validation instead of weakening runtime acceptance.
  }
}

function inspectValidatedRuntime(runtimeRoot, identity, stampPath) {
  const metadata = inspectRuntimeMetadata(runtimeRoot, identity);
  const stamp = readValidationStamp(stampPath);
  if (stamp?.bundleId === metadata.manifest.bundleId
    && stamp.metadataDigest === metadata.metadataDigest) return metadata;

  const inspected = inspectRuntimeBundle(runtimeRoot, identity);
  const metadataDigest = runtimeMetadataDigest(runtimeRoot, inspected.manifest);
  writeValidationStamp(stampPath, inspected.manifest, metadataDigest);
  return { ...inspected, metadataDigest };
}

async function waitForPackagedRuntimeSource({
  app,
  resourcesPath,
  coreHome,
  timeoutMs = DEFAULT_SOURCE_WAIT_TIMEOUT_MS,
  intervalMs = DEFAULT_SOURCE_WAIT_INTERVAL_MS,
}) {
  if (!app.isPackaged) return null;
  if (!Number.isFinite(timeoutMs) || timeoutMs < 0 || !Number.isFinite(intervalMs) || intervalMs <= 0) {
    throw new Error("Packaged runtime source wait requires non-negative timeoutMs and positive intervalMs");
  }
  const source = path.join(resourcesPath, "runtime");
  const identity = {
    version: app.getVersion(),
    platform: process.platform,
    arch: process.arch,
  };
  const deadline = Date.now() + timeoutMs;
  let lastError;
  for (;;) {
    try {
      const sourceManifest = inspectRuntimeManifest(source, identity);
      const expectedIdentity = { ...identity, bundleId: sourceManifest.manifest.bundleId };
      if (typeof coreHome === "string" && path.isAbsolute(coreHome)) {
        const destination = path.join(
          coreHome,
          "versions",
          `${identity.version}-${identity.platform}-${identity.arch}`,
        );
        if (fs.existsSync(destination)) {
          try {
            const installed = inspectValidatedRuntime(
              destination,
              expectedIdentity,
              runtimeValidationStampPath(coreHome, identity, "installed"),
            );
            // The launcher executes browser-helper.cjs directly from packaged resources. Verify
            // that one source payload even when the already-installed runtime lets us skip the
            // other thousands of packaged dependency reads.
            validatePackagedBrowserHelper(source, sourceManifest.manifest);
            packagedSourceMetadata.set(packagedSourceMetadataKey(source, identity), sourceManifest);
            packagedInstalledMetadata.set(packagedInstalledMetadataKey(destination, expectedIdentity), installed);
            return sourceManifest.runtimeRoot;
          } catch {
            // The durable runtime cannot be trusted. Wait for the complete packaged source below
            // so ensurePackagedRuntime can repair it from a fully materialized candidate.
          }
        }
      }
      const metadata = inspectRuntimeMetadata(source, identity);
      packagedSourceMetadata.set(packagedSourceMetadataKey(source, identity), metadata);
      return metadata.runtimeRoot;
    } catch (error) {
      lastError = error;
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    await new Promise(resolve => setTimeout(resolve, Math.min(intervalMs, remaining)));
  }
  const detail = lastError instanceof Error ? lastError.message : String(lastError);
  throw new Error(`Packaged runtime did not fully materialize within ${timeoutMs}ms: ${detail}`);
}

function ensurePackagedRuntime({ app, coreHome, resourcesPath }) {
  if (!app.isPackaged) return null;
  const coreHomeExisted = fs.existsSync(coreHome);
  const identity = {
    version: app.getVersion(),
    platform: process.platform,
    arch: process.arch,
  };
  const source = path.join(resourcesPath, "runtime");
  // The packaged source is never executed directly. Its manifest and file metadata are enough to
  // prove materialization here; any copy promoted to the durable runtime is still fully SHA-256
  // validated before it becomes authoritative.
  const sourceCacheKey = packagedSourceMetadataKey(source, identity);
  const sourceBundle = packagedSourceMetadata.get(sourceCacheKey) ?? inspectRuntimeMetadata(source, identity);
  packagedSourceMetadata.delete(sourceCacheKey);
  const expectedIdentity = { ...identity, bundleId: sourceBundle.manifest.bundleId };
  const versionsRoot = path.join(coreHome, "versions");
  const destination = path.join(
    versionsRoot,
    `${identity.version}-${identity.platform}-${identity.arch}`,
  );
  const installedStamp = runtimeValidationStampPath(coreHome, identity, "installed");
  const installedCacheKey = packagedInstalledMetadataKey(destination, expectedIdentity);
  const cachedInstalled = packagedInstalledMetadata.get(installedCacheKey);
  packagedInstalledMetadata.delete(installedCacheKey);
  if (cachedInstalled && fs.existsSync(destination)) return cachedInstalled.runtimeRoot;
  if (fs.existsSync(destination)) {
    try {
      return inspectValidatedRuntime(destination, expectedIdentity, installedStamp).runtimeRoot;
    } catch {
      // A terminated installer or external cleanup can leave a version directory present but
      // incomplete. Rebuild the launcher-owned bundle transactionally from the signed package.
    }
  }

  fs.mkdirSync(versionsRoot, { recursive: true, mode: 0o700 });
  const temporary = `${destination}.tmp-${process.pid}-${Date.now()}`;
  const previous = `${destination}.previous-${process.pid}-${Date.now()}`;
  let previousMoved = false;
  try {
    fs.cpSync(source, temporary, {
      recursive: true,
      errorOnExist: true,
      force: false,
      verbatimSymlinks: true,
    });
    let candidate;
    try {
      candidate = inspectRuntimeBundle(temporary, expectedIdentity);
    } catch (error) {
      if (!coreHomeExisted) fs.rmSync(coreHome, { recursive: true, force: true });
      throw error;
    }
    const candidateMetadataDigest = runtimeMetadataDigest(temporary, candidate.manifest);
    if (fs.existsSync(destination)) {
      renameAtomicFile(destination, previous);
      previousMoved = true;
    }
    try {
      renameAtomicFile(temporary, destination);
      const committed = inspectRuntimeMetadata(destination, expectedIdentity);
      if (committed.metadataDigest !== candidateMetadataDigest) {
        throw new Error("Committed runtime metadata changed after validated candidate promotion");
      }
      writeValidationStamp(installedStamp, committed.manifest, committed.metadataDigest);
    } catch (error) {
      fs.rmSync(destination, { recursive: true, force: true });
      if (previousMoved) {
        try {
          renameAtomicFile(previous, destination);
          previousMoved = false;
        } catch (restoreError) {
          throw new Error(
            `Runtime replacement failed: ${error instanceof Error ? error.message : String(error)}`
            + `; previous runtime restoration failed: ${restoreError instanceof Error ? restoreError.message : String(restoreError)}`,
          );
        }
      }
      throw error;
    }
    if (previousMoved) {
      // The replacement is already validated and authoritative here. Windows can keep an old
      // runtime DLL/executable locked briefly after its owner exits; failure to delete that stale
      // backup must not turn a successful runtime commit into a launcher startup failure.
      removeCommittedPreviousRuntime(previous);
      previousMoved = false;
    }
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
    if (previousMoved && fs.existsSync(previous) && !fs.existsSync(destination)) {
      renameAtomicFile(previous, destination);
      previousMoved = false;
    }
  }
  try { fs.chmodSync(destination, 0o700); } catch {}
  return destination;
}

module.exports = {
  ensurePackagedRuntime,
  validateRuntimeBundle,
  waitForPackagedRuntimeSource,
};
