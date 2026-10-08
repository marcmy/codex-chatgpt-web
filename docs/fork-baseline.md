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
Bigger Context, GPT-5.6 uses 270,000 / 240,000; GPT-6 retains its standard Plus
budget under upstream's measured account rules. On Pro with Bigger Context,
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
