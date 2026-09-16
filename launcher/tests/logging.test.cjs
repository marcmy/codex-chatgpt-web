const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { PassThrough } = require("node:stream");
const {
  createLogger,
  exportSanitizedLogs,
  installProcessDiagnosticGuards,
  registerLoggedIpc,
  sanitize,
} = require("../electron/logging.cjs");

test("launcher logs redact tunnel ids, runtime keys, and bearer credentials", () => {
  assert.deepEqual(sanitize({
    line: "tunnel_0123456789abcdef0123456789abcdef sk-exampleRuntimeSecret123",
    authorization: "Bearer this-must-never-be-recorded",
    nested: { controlToken: "also-secret" },
  }), {
    line: "[tunnel-id] [runtime-key]",
    authorization: "[redacted]",
    nested: { controlToken: "[redacted]" },
  });
});

test("failed launcher IPC calls are written to runtime activity", async () => {
  let registered;
  const errors = [];
  const ipcMain = {
    handle(channel, handler) {
      registered = { channel, handler };
    },
  };
  registerLoggedIpc(
    ipcMain,
    { error: (event, detail) => errors.push({ event, detail }) },
    "launcher:test",
    async () => {
      throw new Error("visible failure");
    },
  );

  await assert.rejects(registered.handler({}, 1), /visible failure/);
  assert.deepEqual(errors, [{
    event: "launcher.ipc_failed",
    detail: { channel: "launcher:test", message: "visible failure" },
  }]);
});

test("launcher activity restores valid records from the previous process", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-web-gpt-logging-"));
  const filePath = path.join(root, "launcher.jsonl");
  try {
    fs.writeFileSync(filePath, [
      JSON.stringify({ at: "2026-07-28T00:00:00.000Z", level: "info", event: "previous", detail: {} }),
      "not-json",
      "",
    ].join("\n"));
    const logger = createLogger({ filePath });
    assert.deepEqual(logger.recent().map((record) => record.event), ["previous"]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("completion-fence compaction happens before launcher persistence and publication", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-web-gpt-fence-log-"));
  const filePath = path.join(root, "launcher.jsonl");
  const published = [];
  try {
    const logger = createLogger({ filePath, publish: (record) => published.push(record) });
    const trace = "fence_trace";
    const attempt = (requestId, revision = "none") => [
      `[chatgpt-web-helper] [chatgpt-web] browser turn ${trace} phase=completion_fence_begin_requested requestId=${requestId}`,
      `[chatgpt-web] browser turn ${trace} phase=completion_fence_begin_received requestId=${requestId}`,
      `[chatgpt-web] browser turn ${trace} phase=completion_fence_begin_resolved requestId=${requestId} revision=${revision}`,
      `[chatgpt-web-helper] [chatgpt-web] browser turn ${trace} phase=completion_fence_begin_acknowledged requestId=${requestId} revision=${revision}`,
    ];

    for (const line of attempt(1)) logger.info("runtime.daemon_stdout", { line });
    for (const line of attempt(2)) logger.info("runtime.daemon_stdout", { line });
    const recovery = `[chatgpt-web] browser turn ${trace} phase=completion_fence_begin_resolved requestId=3 revision=42`;
    logger.info("runtime.daemon_stdout", { line: recovery });

    const persisted = fs.readFileSync(filePath, "utf8").trim().split(/\r?\n/).map(line => JSON.parse(line));
    assert.equal(persisted.length, 5);
    assert.equal(logger.recent().length, 5);
    assert.equal(published.length, 5);
    assert.match(persisted.at(-1).detail.line, /revision=42 suppressedRetries=1$/);
    assert.equal(persisted.some(record => record.detail.line.includes("requestId=2")), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("exported launcher logs remove local usernames, private ChatGPT titles, and URL paths", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-web-gpt-export-"));
  const filePath = path.join(root, "launcher.jsonl");
  const destinationPath = path.join(root, "shared", "diagnostics.jsonl");
  try {
    fs.writeFileSync(`${filePath}.1`, `${JSON.stringify({
      at: "2026-08-23T00:00:00.000Z",
      level: "error",
      event: "runtime.daemon_stdout",
      detail: {
        line: "prompt_attachment failed at C:\\Users\\private.user\\.codex and encoded C:\\\\Users\\\\private.user\\\\.codex; connector missing; visible rows: Private roadmap, Health notes",
      },
    })}\n`);
    fs.writeFileSync(filePath, `${JSON.stringify({
      at: "2026-08-23T00:01:00.000Z",
      level: "info",
      event: "runtime.stdout",
      detail: {
        line: "config loaded from /Users/local-person/.codex/config.toml",
        prompt: "private prompt",
        connector: "Codex Native2",
        url: "https://chatgpt.com/c/private-conversation?state=oauth-secret&email=private@example.com",
        message: "failed while loading 'https://accounts.google.com/o/oauth2/v2/auth?state=oauth-secret&login_hint=private@example.com'",
      },
    })}\n`);

    assert.equal(exportSanitizedLogs({ filePath, destinationPath }), 2);
    const exported = fs.readFileSync(destinationPath, "utf8");
    assert.doesNotMatch(exported, /private\.user|local-person|Private roadmap|Health notes|private prompt|private-conversation|oauth-secret|private@example\.com/);
    assert.match(exported, /\[user-home\]/);
    assert.match(exported, /visible rows: \[redacted\]/);
    assert.match(exported, /Codex Native2/);
    assert.match(exported, /"prompt":"\[redacted\]"/);
    assert.match(exported, /https:\/\/chatgpt\.com/);
    assert.match(exported, /https:\/\/accounts\.google\.com/);
    assert.throws(
      () => exportSanitizedLogs({ filePath, destinationPath: filePath }),
      /Refusing to overwrite a launcher source log/,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a closed Windows diagnostic pipe is recorded without becoming an uncaught process error", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-web-gpt-process-pipe-"));
  const filePath = path.join(root, "process-stream-errors.log");
  const stream = new PassThrough();
  try {
    installProcessDiagnosticGuards({ filePath, streams: [stream] });
    stream.emit("error", Object.assign(new Error("write EOF"), { code: "EOF" }));
    assert.match(fs.readFileSync(filePath, "utf8"), /write EOF/);
  } finally {
    stream.destroy();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
