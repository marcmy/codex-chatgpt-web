import { expect, test } from "bun:test";
import { resolveChatGptEffortCapabilities } from "../src/chatgpt-session";

test.each([
  [3, "plus", false, false],
  [4, "plus", false, false],
  [4, undefined, false, false],
  [4, "pro", true, false],
  [4, "PRO", true, false],
  [5, "plus", true, true],
] as const)(
  "effort capabilities optionCount=%s plan=%s => extraHigh=%s pro=%s",
  (optionCount, planType, extraHighAvailable, proAvailable) => {
    expect(resolveChatGptEffortCapabilities(optionCount, planType)).toEqual({
      extraHighAvailable,
      proAvailable,
    });
  },
);
