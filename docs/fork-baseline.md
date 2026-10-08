# Fork baseline

The application, launcher, build scripts and tests were restored from upstream
`388fca546553921cfc3b695930bd7140ce99d486` (6.1.6). The earlier fork is preserved in
Git history at `a1bbd13b01b3244331474d44d0e61fb4d9cccb30`; this is a normal forward
commit, not a history rewrite.

## Retained infrastructure and security

- Fork-owned GitHub workflows and Windows installer artifact uploads.
- Ad-hoc macOS signing for pull-request packages when no signing identity is set,
  preserving the existing fork CI fix and strict archive-signature verification.
- Upstream sync now stops on conflicts, validates the merged tree and opens a PR.
  It explicitly dispatches platform CI instead of relying on GITHUB_TOKEN pushes.
  The repository must allow Actions to create pull requests.
- Existing ignore rules for local runtime, verification and attachment outputs.
- Current upstream security dependency overrides, with the fork's `ip-address`
  10.7.2 update. Lockfiles remain frozen in CI; audits remain release gates.
- Three narrowly reapplied CodeQL fixes from `b91b0b7`: exact ChatGPT origin
  comparisons, single-pass XML entity decoding and single-line public errors.
- The existing 90-second CI allowance for the tokenizer-heavy multipart test,
  retaining upstream assertions and transport behavior.
- A 30-second allowance for the 600,000-character multipart prompt contract,
  matching its adjacent large-history test on slower hosted runners.

## Scope for subsequent changes

Model-picker changes are a separate commit. Older fork behavior is deliberately
left out of this baseline. Before porting any of it, compare the current upstream
implementation and cover the actual server/browser boundary. Candidates include
retained-turn editing, remount streaming, Windows file-link projection, multipart
headroom, rate-limit recovery and timeout headroom. The old implementations and
their tests remain available in the pre-reset history.

## Model picker

GPT-6 support, browser selection and measured transport limits come from upstream
6.1.6. The fork groups Instant, Medium, High and account-supported Extra High under
`chatgpt-web/gpt-6-sol` (displayed as GPT-6 (Web)) and `chatgpt-web/gpt-5.6-sol`.
The separate Instant slugs remain hidden and routable for saved tasks.

A single catalog row must advertise a budget safe for all its efforts. Both rows
therefore use the minimum context and compaction budget across supported efforts:
41,000 / 32,000 on Plus in standard-context mode. GPT-6 retains that budget on Plus
when Bigger Context is enabled, and 111,193 / 95,000 on Pro. This can make Codex
compact earlier when a higher effort is selected. Actual browser transport limits
still follow upstream's selected-effort rules, including GPT-6's 240,000 / 220,000
Pro reasoning limit with Bigger Context. Native model metadata remains intact.

The two primary Web rows are inserted before GPT-6 Astra and GPT-5.6 Sol using
their native priorities. Existing account-gated Pro and other native models remain
available. No old fork application behavior has been reintroduced.

The Web-to-native model switch must be checked after installing the rebuilt
launcher in a fresh task. Source and CI results do not establish that the previous
encrypted-compaction failure is resolved in an existing live conversation.
