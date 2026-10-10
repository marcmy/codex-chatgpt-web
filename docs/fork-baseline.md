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
6.1.6. The fork groups Medium, High and account-supported Extra High under
`chatgpt-web/gpt-6-sol` (displayed as GPT-6 (Web)) and `chatgpt-web/gpt-5.6-sol`.
The separate Instant slugs remain hidden and routable for saved tasks.

A single catalog row must advertise the same budget for every supported effort.
Instant is hidden and excluded from the reasoning rows to preserve their full
context limits. On Plus, both rows use 90,000 / 80,000 in standard mode. With
Bigger Context, both GPT-6 and GPT-5.6 use 270,000 / 240,000. The fork explicitly
overrides upstream's GPT-6 Plus restriction and enables the existing multipart
transport for that family; retention at the larger Plus window still needs live
validation. On Pro with Bigger Context,
GPT-6 uses 240,000 / 220,000 and GPT-5.6 uses 333,579 / 285,000. Native model
metadata remains intact.

Native filesystem snapshots can omit network policy after compaction or steering.
Those claims are checked against the current native rollout, which supplies the
omitted network value. Explicit policy conflicts and unproven grants still fail.

The two primary Web rows are inserted before GPT-6 Astra and GPT-5.6 Sol using
their native priorities. Existing account-gated Pro and other native models remain
available. No old fork application behavior has been reintroduced.

The Web-to-native model switch must be checked after installing the rebuilt
launcher in a fresh task. Source and CI results do not establish that the previous
encrypted-compaction failure is resolved in an existing live conversation.

## Exact browser submission text

ChatGPT's connector composer serializes user text as Markdown. That conversion
can escape JSON quotes, backslashes and transport fences after the bridge has
verified the composer text, invalidating staged payload hashes and increasing
the submitted token count. The fork restores the verified canonical text in the
browser-issued conversation request for the current Send. The guard retains the
connector prefix, metadata and attachments, requires the current transaction or
turn capability before correcting Markdown changes, and aborts unclassified or
unbound mutations. Tool-free compaction uses the owned checkpoint contract
instead of introducing a tool capability. The request route is removed when
submission settles.

A live browser fixture reproduced the corruption and confirmed that the corrected
request is stored unchanged with the connector selected. This establishes text
integrity for that fixture; it does not establish GPT-6 Plus retention at 240k.

## Upstream 6.1.7 sync

Fork 6.1.10 merges upstream tag `v6.1.7` at
`f9ad4ae83a579287105ad822dd0c3e0029b04ef6`. It includes the final Markdown
alignment fixes, consistent answer-content observation, failed-tab retention,
launcher recovery changes and experimental Luna/Think Bigger Context support.

The grouped reasoning rows and GPT-6 Plus override remain: both GPT-6 and GPT-5.6
use a 270,000-token window with compaction at 240,000 on Plus. GPT-6 on Pro retains
upstream's 240,000 / 220,000 limits. Settings and recommendation text describe
these fork budgets in all five launcher languages.

Upstream now represents omitted network policy explicitly and resolves it from
the current native rollout on the initial request as well as continuation and
steering. That implementation replaces the overlapping fork implementation;
the fork regression tests for omitted policy and conflicting grants remain.

The final DOM alignment fixes address reconciliation after browser completion.
They do not establish a fix for the late ChatGPT terminal stream events reported
in upstream issue #791. Browser completion delay and retention at the larger Plus
window remain live checks.
