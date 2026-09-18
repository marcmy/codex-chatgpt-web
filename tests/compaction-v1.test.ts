import { expect, test } from "bun:test";
import {
  buildCompactV1Output,
  extractCompactUserMessages,
  isReadableCompactionSummaryText,
  SUMMARY_PREFIX,
} from "../src/responses/compaction";

test("recognizes both Codex v1 and transparent v2 readable compaction summaries", () => {
  expect(isReadableCompactionSummaryText(`${SUMMARY_PREFIX}\nv1 summary`)).toBe(true);
  expect(isReadableCompactionSummaryText(`${SUMMARY_PREFIX}\n\nv2 summary`)).toBe(true);
  expect(isReadableCompactionSummaryText(`${SUMMARY_PREFIX}not a summary boundary`)).toBe(false);
});

test("v1 compaction drops raw images while retaining user text and metadata", () => {
  const input = Array.from({ length: 12 }, (_, index) => ({
    type: "message",
    role: "user",
    id: `user-${index}`,
    metadata: { source: `turn-${index}` },
    content: [
      { type: "input_text", text: `request-${index}` },
      {
        type: "input_image",
        image_url: `data:image/png;base64,image-${index}`,
        detail: "high",
      },
    ],
  }));

  const output = buildCompactV1Output(extractCompactUserMessages(input), "checkpoint");
  const retained = output.slice(0, -1) as Array<{
    id?: string;
    metadata?: { source?: string };
    content: Array<{ type: string; text?: string; image_url?: string; detail?: string }>;
  }>;
  expect(retained).toHaveLength(12);
  expect(retained.map(item => item.id)).toEqual(input.map(item => item.id));
  expect(retained.map(item => item.metadata?.source)).toEqual(input.map(item => item.metadata.source));
  expect(retained.flatMap(item => item.content).filter(block => block.type === "input_image")).toEqual([]);
  expect(retained.flatMap(item => item.content).map(block => block.text))
    .toEqual(input.map(item => item.content[0]!.text));
});

test("v1 recompaction does not carry already-checkpointed images into another browser epoch", () => {
  const oldImage = "data:image/png;base64,old-screenshot";
  const newImage = "data:image/png;base64,new-screenshot";
  const input = [
    {
      type: "message",
      role: "user",
      id: "old-image-message",
      metadata: { source: "old-turn" },
      content: [
        { type: "input_text", text: "Old screenshot request" },
        { type: "input_image", image_url: oldImage, detail: "high" },
      ],
    },
    {
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: `${SUMMARY_PREFIX}\nPrevious visual checkpoint` }],
    },
    {
      type: "message",
      role: "user",
      id: "new-image-message",
      metadata: { source: "new-turn" },
      content: [
        { type: "input_text", text: "New screenshot request" },
        { type: "input_image", image_url: newImage, detail: "high" },
      ],
    },
  ];

  const extracted = extractCompactUserMessages(input) as Array<{
    id?: string;
    metadata?: { source?: string };
    content: Array<{ type: string; text?: string; image_url?: string }>;
  }>;
  expect(extracted.map(item => item.id)).toEqual(["old-image-message", "new-image-message"]);
  expect(extracted[0]!.metadata?.source).toBe("old-turn");
  expect(extracted[0]!.content).toEqual([{ type: "input_text", text: "Old screenshot request" }]);
  expect(extracted[1]!.content.at(-1)).toMatchObject({ type: "input_image", image_url: newImage });

  const output = buildCompactV1Output(extracted, "next checkpoint");
  const serialized = JSON.stringify(output);
  expect(serialized).toContain("Old screenshot request");
  expect(serialized).toContain("New screenshot request");
  expect(serialized).not.toContain(oldImage);
  expect(serialized).not.toContain(newImage);
});

test("v1 compaction drops persisted one-pixel sentinels and real image payloads", () => {
  const placeholder = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
  const output = buildCompactV1Output(extractCompactUserMessages([{
    type: "message",
    role: "user",
    content: [
      { type: "input_text", text: "keep the request" },
      { type: "input_image", image_url: placeholder },
      { type: "input_image", image_url: "data:image/png;base64,real-image" },
    ],
  }]), "checkpoint");

  expect(JSON.stringify(output)).not.toContain(placeholder);
  expect(JSON.stringify(output)).not.toContain("data:image/png;base64,real-image");
  expect(JSON.stringify(output)).toContain("keep the request");
});
