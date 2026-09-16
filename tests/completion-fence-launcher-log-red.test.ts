import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { expect, test } from "bun:test";

test("launcher ships a completion-fence diagnostic compactor", () => {
  expect(existsSync(resolve(import.meta.dir, "../launcher/electron/completion-fence-diagnostics.cjs"))).toBe(true);
});
