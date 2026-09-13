import { expect, test } from "bun:test";
import { CHATGPT_WEB_MODEL_ID } from "../src/adapters/chatgpt-web/model";
import { chatGptInstructionLineage, chatGptTurnExecutionKey } from "../src/adapters/chatgpt-web/turn-execution";
import { parseRequest } from "../src/responses/parser";

const threadId = "thread_reconnect_123";
const turnId = "turn_reconnect_123";
const instructionText = "Inspect the project and report what changed.";

function request(messageIds: string[]) {
  return parseRequest({
    model: CHATGPT_WEB_MODEL_ID,
    stream: true,
    client_metadata: {
      "x-codex-turn-metadata": JSON.stringify({ thread_id: threadId, turn_id: turnId }),
    },
    input: messageIds.map(id => ({
      type: "message",
      role: "user",
      id,
      content: [{ type: "input_text", text: instructionText }],
      internal_chat_message_metadata_passthrough: { turn_id: turnId },
    })),
  });
}

test("a reconnect may reissue the same current instruction under a new item id", () => {
  const first = request(["msg_original"]);
  const reissued = request(["msg_reissued"]);

  expect(chatGptInstructionLineage(reissued).current)
    .toBe(chatGptInstructionLineage(first).current);
  expect(chatGptTurnExecutionKey(reissued)).toBe(chatGptTurnExecutionKey(first));
});

test("an appended same-text instruction still advances canonical instruction lineage", () => {
  const first = request(["msg_original"]);
  const steered = request(["msg_original", "msg_steered"]);
  const firstLineage = chatGptInstructionLineage(first);
  const steeredLineage = chatGptInstructionLineage(steered);

  expect(steeredLineage.current).not.toBe(firstLineage.current);
  expect(steeredLineage.predecessors.has(firstLineage.current)).toBeTrue();
  expect(chatGptTurnExecutionKey(steered)).not.toBe(chatGptTurnExecutionKey(first));
});
