const COMPLETION_FENCE_LINE = /\bbrowser turn (\S+) phase=(completion_fence_begin_(?:requested|received|resolved|acknowledged)) requestId=(\S+)(?:\s+revision=(\S+))?/;

class CompletionFenceDiagnosticGate {
  constructor() {
    this.blocked = new Map();
  }

  reset(trace) {
    this.blocked.delete(trace);
  }
}

function compactCompletionFenceDiagnosticRecord(record, gate) {
  if (!record
    || record.event !== "runtime.daemon_stdout"
    || !record.detail
    || typeof record.detail.line !== "string"
    || !(gate instanceof CompletionFenceDiagnosticGate)) {
    return record;
  }

  const match = record.detail.line.match(COMPLETION_FENCE_LINE);
  if (!match) return record;

  const [, trace, phase, requestId, revision] = match;
  let state = gate.blocked.get(trace);

  if (!state) {
    if ((phase === "completion_fence_begin_resolved" || phase === "completion_fence_begin_acknowledged")
      && revision === "none") {
      state = {
        firstBlockedRequestId: requestId,
        suppressedRetries: 0,
        countedRequestIds: new Set(),
      };
      gate.blocked.set(trace, state);
    }
    return record;
  }

  if (requestId === state.firstBlockedRequestId) return record;

  const isResolution = phase === "completion_fence_begin_resolved"
    || phase === "completion_fence_begin_acknowledged";
  if (isResolution && revision && revision !== "none") {
    const compacted = {
      ...record,
      detail: {
        ...record.detail,
        line: `${record.detail.line} suppressedRetries=${state.suppressedRetries}`,
      },
    };
    gate.reset(trace);
    return compacted;
  }

  if (isResolution && revision === "none" && !state.countedRequestIds.has(requestId)) {
    state.countedRequestIds.add(requestId);
    state.suppressedRetries += 1;
  }

  return undefined;
}

module.exports = {
  CompletionFenceDiagnosticGate,
  compactCompletionFenceDiagnosticRecord,
};
