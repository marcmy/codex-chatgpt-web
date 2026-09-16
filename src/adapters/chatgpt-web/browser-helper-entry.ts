import { stderr } from "node:process";
import { ChatGptBrowserWorker } from "./browser-worker";
import { installChatGptBrowserPerfHardening } from "./browser-perf-hardening";
import { createProcessLineWriter } from "./process-line-writer";

// This entrypoint runs before browser-helper-main owns console.*. Keep every hardening diagnostic on
// stderr so its startup marker and later telemetry can never corrupt the helper's JSON stdout
// protocol. A closed parent pipe merely disables these diagnostics; helper-main owns shutdown.
const hardeningDiagnostic = createProcessLineWriter(stderr, () => {});

// Install before the helper protocol starts dispatching turns. Keep browser-worker itself unchanged
// so managed-Chrome/dev paths retain their existing behavior while the Electron launcher path—the
// surface affected by renderer starvation—gets the protective cadence and diagnostics.
installChatGptBrowserPerfHardening(ChatGptBrowserWorker, {
  log: message => {
    hardeningDiagnostic.write(message);
  },
});

void import("./browser-helper-main").catch(error => {
  console.error(
    `[chatgpt-web] browser helper failed to start: ${error instanceof Error ? error.stack ?? error.message : String(error)}`,
  );
  process.exitCode = 1;
});
