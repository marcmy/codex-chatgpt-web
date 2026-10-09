import { createHash } from "node:crypto";

export interface CompletionCaptureMarker {
  kind: string;
  value: string | boolean;
  messageHash?: string;
  role?: string;
  channel?: string;
}

/** Diagnostic projection only: never exports response content, tool arguments, or resume tokens. */
export class CompletionCaptureEvents {
  private pending = "";
  private eventName = "message";
  private data: string[] = [];
  private context: Pick<CompletionCaptureMarker, "messageHash" | "role" | "channel"> = {};

  constructor(private readonly emit: (markers: CompletionCaptureMarker[]) => void) {}

  push(text: string): void {
    this.pending += text;
    const lines = this.pending.split("\n");
    this.pending = lines.pop()!;
    for (const raw of lines) {
      const line = raw.replace(/\r$/, "");
      if (!line) { this.flush(); continue; }
      if (line.startsWith("event:")) this.eventName = line.slice(6).trim();
      if (line.startsWith("data:")) this.data.push(line.slice(5).trimStart());
      if (this.data.reduce((sum, item) => sum + item.length, 0) > 2_000_000) {
        this.data = []; this.emit([{ kind: "parser_limit", value: true }]);
      }
    }
    if (this.pending.length > 2_000_000) {
      this.pending = ""; this.emit([{ kind: "parser_limit", value: true }]);
    }
  }

  private flush(): void {
    const markers: CompletionCaptureMarker[] = [];
    const payload = this.data.join("\n"); this.data = [];
    const contextFor = (message: any): void => {
      if (!message || typeof message !== "object") return;
      if (typeof message.id === "string") {
        this.context = { messageHash: createHash("sha256").update(message.id).digest("hex") };
      }
      if (["assistant", "user", "tool", "system"].includes(message.author?.role)) this.context.role = message.author.role;
      if (["final", "analysis", "commentary", "summary"].includes(message.channel)) this.context.channel = message.channel;
    };
    const inspect = (node: any, depth = 0): void => {
      if (!node || typeof node !== "object" || depth > 12) return;
      if (node.message) contextFor(node.message);
      if (node.p === "/message") contextFor(node.v);
      if (node.author) contextFor(node);
      if (node.type === "message_marker" && typeof node.message_id === "string") contextFor({ id: node.message_id });
      if (["message_stream_complete", "server_ste_metadata", "conversation_detail_metadata", "resume_conversation_token", "input_message", "message_marker"].includes(node.type)) {
        markers.push({ kind: "type", value: node.type, ...this.context });
      }
      if (["finished_successfully", "in_progress", "finished_partial", "error"].includes(node.status)) {
        markers.push({ kind: "status", value: node.status, ...this.context });
      }
      if (node.end_turn === true) markers.push({ kind: "end_turn", value: true, ...this.context });
      if (node.p === "/message/status" && ["finished_successfully", "in_progress", "finished_partial", "error"].includes(node.v)) {
        markers.push({ kind: "status_patch", value: node.v, ...this.context });
      }
      if (node.p === "/message/end_turn" && typeof node.v === "boolean") markers.push({ kind: "end_turn_patch", value: node.v, ...this.context });
      if (node.p === "/message/channel" && ["final", "analysis", "commentary", "summary"].includes(node.v)) this.context.channel = node.v;
      for (const [key, value] of Object.entries(node)) {
        if (["content", "parts", "text", "arguments", "input", "output", "author", "metadata"].includes(key)) continue;
        if (Array.isArray(value)) value.forEach(item => inspect(item, depth + 1));
        else if (value && typeof value === "object") inspect(value, depth + 1);
      }
    };
    if (payload === "[DONE]") markers.push({ kind: "done", value: true });
    else if (payload) {
      try { inspect(JSON.parse(payload)); } catch { markers.push({ kind: "unparsed_frame", value: true }); }
    }
    if (["done", "complete", "error"].includes(this.eventName)) markers.push({ kind: "event", value: this.eventName });
    this.eventName = "message";
    if (markers.length) this.emit(markers);
  }
}
