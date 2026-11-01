const assert = require("node:assert/strict");
const { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const path = require("node:path");
const { createRequire } = require("node:module");
const { spawnSync } = require("node:child_process");
const { test } = require("node:test");

function fixture(t) {
  const root = mkdtempSync(path.join(tmpdir(), "launcher-globs-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

test("ASAR preserves files and honors native module and directory unpack globs", async (t) => {
  const asar = require("@electron/asar");
  const root = fixture(t);
  const input = path.join(root, "app");
  mkdirSync(path.join(input, "native"), { recursive: true });
  writeFileSync(path.join(input, "main.js"), "module.exports = 42;\n");
  writeFileSync(path.join(input, "native", "addon.node"), "native fixture");
  writeFileSync(path.join(input, "native", "support.txt"), "support fixture");
  for (const options of [{ unpack: "**/*.node" }, { unpackDir: "**/native" }]) {
    const archive = path.join(root, options.unpack ? "files.asar" : "dirs.asar");
    await asar.createPackageWithOptions(input, archive, options);
    assert.equal(asar.extractFile(archive, "main.js").toString(), "module.exports = 42;\n");
    assert.equal(asar.statFile(archive, "native/addon.node").unpacked, true);
    assert.equal(readFileSync(archive + ".unpacked/native/addon.node", "utf8"), "native fixture");
    if (options.unpackDir) assert.equal(asar.statFile(archive, "native/support.txt").unpacked, true);
  }
});

test("directory comparison retains include and exclude filters", (t) => {
  const { compareSync } = require("dir-compare");
  const root = fixture(t);
  const left = path.join(root, "left");
  const right = path.join(root, "right");
  for (const dir of [left, right]) {
    mkdirSync(dir);
    writeFileSync(path.join(dir, "same.txt"), "same");
    writeFileSync(path.join(dir, "change.txt"), dir === left ? "left" : "right");
    writeFileSync(path.join(dir, "ignored.skip.txt"), dir);
    writeFileSync(path.join(dir, "ignored.js"), dir);
  }
  const result = compareSync(left, right, {
    compareContent: true, includeFilter: "*.txt", excludeFilter: "*.skip.txt",
  });
  assert.deepEqual(result.diffSet.filter((entry) => entry.state !== "equal").map((entry) => entry.name1), ["change.txt"]);
});

test("legacy glob traversal and filelist matching retain packaging semantics", (t) => {
  const root = fixture(t);
  mkdirSync(path.join(root, "nested"));
  for (const name of ["main.js", ".hidden.js", "nested/addon.node", "nested/文.js", "skip.txt"])
    writeFileSync(path.join(root, name), name);
  const asarRequire = createRequire(require.resolve("@electron/asar"));
  const glob = asarRequire("glob");
  assert.deepEqual(glob.sync("**/*.{js,node}", { cwd: root, dot: true, nodir: true }).sort(),
    [".hidden.js", "main.js", "nested/addon.node", "nested/文.js"].sort());
  assert.deepEqual(glob.sync("missing*.js", { cwd: root, nonull: true }), ["missing*.js"]);
  const filelistRequire = createRequire(require.resolve("filelist"));
  assert.deepEqual(filelistRequire("minimatch").match(["main.js", "nested/文.js", "skip.txt"], "**/*.js"),
    ["main.js", "nested/文.js"]);
});

test("amplifying glob preprocessing terminates within a bounded subprocess", () => {
  const child = spawnSync(process.execPath, ["-e", `
    const { Minimatch } = require("minimatch");
    new Minimatch("**/../a/b/".repeat(24) + "*.js", { optimizationLevel: 2 }).match("main.js");
  `], { cwd: path.resolve(__dirname, ".."), encoding: "utf8", timeout: 10000, windowsHide: true });
  assert.ifError(child.error);
  assert.equal(child.status, 0, child.stderr);
});
