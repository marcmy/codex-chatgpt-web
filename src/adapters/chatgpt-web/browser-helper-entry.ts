import { ChatGptBrowserWorker } from "./browser-worker";
import { installChatGptBrowserPerfHardening } from "./browser-perf-hardening";

// Install before the helper protocol starts dispatching turns. Keep browser-worker itself unchanged
// so managed-Chrome/dev paths retain their existing behavior while the Electron launcher path—the
// surface affected by renderer starvation—gets the protective cadence and diagnostics.
installChatGptBrowserPerfHardening(ChatGptBrowserWorker);

void import("./browser-helper-main").catch(error => {
  console.error(
    `[chatgpt-web] browser helper failed to start: ${error instanceof Error ? error.stack ?? error.message : String(error)}`,
  );
  process.exitCode = 1;
});
