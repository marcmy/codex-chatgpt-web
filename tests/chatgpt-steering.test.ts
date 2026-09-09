import { describe, expect, test } from "bun:test";
import { attachChatGptSteering, chatGptSteeringControlTag } from "../src/adapters/chatgpt-web/steering";

describe("ChatGPT in-place steering", () => {
  test("uses a stable opaque control tag", () => {
    const a = chatGptSteeringControlTag("turn-token");
    const b = chatGptSteeringControlTag("turn-token");
    expect(a).toBe(b);
    expect(a).toHaveLength(24);
  });

  test("appends an authenticated steering envelope after ordinary tool output", () => {
    const token = "turn-token";
    const result = attachChatGptSteering(
      { content: [{ type: "text", text: "ordinary tool output" }] },
      token,
      [{ instruction: "revision-2", text: "<new> & continue" }],
    );
    expect(result.content).toHaveLength(2);
    expect(result.content[0]).toEqual({ type: "text", text: "ordinary tool output" });
    const envelope = (result.content[1] as { text: string }).text;
    expect(envelope).toContain(`<codex_native_steer control="${chatGptSteeringControlTag(token)}">`);
    expect(envelope).toContain("\\u003cnew\\u003e");
    expect(envelope).toContain("\\u0026");
  });
});
