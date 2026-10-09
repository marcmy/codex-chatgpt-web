# Targeted completion capture

This passive recorder collects stream terminal markers and hashed DOM block identities, not answer text, request bodies, authorization headers, or resume tokens. It never sends a ChatGPT message or clicks Stop. Run it before sending a message with the pinned Bun runtime:

```powershell
bun scripts/capture-chatgpt-completion.cjs .verify-artifacts/completion-capture
```

Wait for `page_attached` and an idle `dom_state` in the new JSONL file before sending. `current.json` contains the log path and two unique control-file paths. Creating its `pauseFile` marks the observed pause and starts a three-minute recording budget. Creating its `stopFile` ends recording immediately. These controls detach the recorder; they do not stop the ChatGPT turn. Maximum recording duration is fifteen minutes. If the turn is still stuck at the three-minute pause limit, the user can stop the test turn manually and mark that intervention; do not label it a natural completion.

Use this prompt on GPT-6 Web, High, with the current Bigger Context setting. Use a fresh Codex chat for a standalone comparison and keep the full prompt identical across conditions:

> Answer directly without tools, browsing, files, code execution, or clarifying questions. Write a self-contained 500–700-word report comparing a monolithic desktop application with one built around plugins. Use exactly four sections: Architecture, Reliability, Updates, and Recommendation. In Updates, include one Markdown table with four rows comparing deployment, compatibility, rollback, and testing. Discuss both advantages and disadvantages, and finish with a separate two-sentence concluding paragraph beginning "Recommendation:". This is a writing exercise; do not inspect a repository or perform any actions.

An output word target is approximate, not a context or stream limit. Record actual word count from the completed export if available. DOM root character counts can include user prompts, tool/UI text, and history; do not equate them to final-answer tokens.

For a controlled comparison, run the exact prompt once with the bridge connector and once in an ordinary ChatGPT conversation using the same Web model and effort. Compare the time from the last answer-block change to current assistant terminal patches and browser Stop disappearance. The standalone test reduces tool and context-history confounders but does not prove the cause of failures in a long retained task conversation.

SSE markers are projected with message ID hashes, role and channel when available. Preserve every status transition; a replayed historical message ending is not evidence that the current answer ended. For captured terminal remount failures, the runtime diagnostic additionally preserves bounded hashes, lengths, tags and source ranges of committed, pending and observed blocks. The instrumentation does not waive Markdown consistency checks or change turn-completion rules.
