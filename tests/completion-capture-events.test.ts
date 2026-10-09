import { expect, test } from "bun:test";
import { CompletionCaptureEvents, type CompletionCaptureMarker } from "../scripts/completion-capture-events";

test("replayed user completion does not suppress the current assistant terminal patches", () => {
  const events: CompletionCaptureMarker[][] = [];
  const parser = new CompletionCaptureEvents(markers => events.push(markers));
  const frame = (value: unknown) => parser.push(`data: ${JSON.stringify(value)}\n\n`);
  frame({ message: { id: "historical", author: { role: "user" }, status: "finished_successfully", end_turn: true } });
  frame({ p: "/message", v: { id: "current", author: { role: "assistant" }, channel: "final", status: "in_progress", content: { parts: ["PRIVATE ANSWER"] } } });
  frame({ p: "/message/status", v: "finished_successfully" });
  frame({ p: "/message/end_turn", v: true });
  frame({ type: "message_stream_complete" });
  parser.push("data: [DONE]\n\n");
  const markers = events.flat();
  expect(markers.filter(marker => marker.value === "finished_successfully")).toHaveLength(2);
  const terminal = markers.find(marker => marker.kind === "status_patch")!;
  expect(terminal.role).toBe("assistant"); expect(terminal.channel).toBe("final");
  expect(terminal.messageHash).not.toBe(markers[0]!.messageHash);
  expect(markers.at(-1)!.kind).toBe("done");
  expect(JSON.stringify(events)).not.toContain("PRIVATE ANSWER");
  expect(JSON.stringify(events)).not.toContain('"current"');
});

test("SSE chunk boundaries, CRLF, and multiline data preserve a terminal frame", () => {
  const events: CompletionCaptureMarker[][] = [];
  const parser = new CompletionCaptureEvents(markers => events.push(markers));
  for (const piece of ['event: complete\r\ndata: {"p":"/message/status",\r\n', 'data: "v":"finished_successfully"}\r\n\r', '\n']) parser.push(piece);
  expect(events.flat()).toEqual([{ kind: "status_patch", value: "finished_successfully" }, { kind: "event", value: "complete" }]);
});

test("tool arguments and arbitrary types cannot enter completion diagnostics", () => {
  const events: CompletionCaptureMarker[][] = [];
  const parser = new CompletionCaptureEvents(markers => events.push(markers));
  parser.push('data: {"type":"PRIVATE_TEXT","arguments":{"status":"finished_successfully"},"metadata":{"resume_token":"SECRET"}}\n\n');
  expect(events).toEqual([]);
  parser.push(`data: ${"x".repeat(2_000_001)}\n\n`);
  expect(events.flat()).toEqual([{ kind: "parser_limit", value: true }]);
});
