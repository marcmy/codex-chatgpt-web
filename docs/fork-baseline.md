# Fork baseline

The application, launcher, build scripts and tests were restored from upstream
`92a356fac2292e3af5a97ab7ba634edd8d38621e` (6.1.5). The earlier fork is preserved in
Git history at `a1bbd13b01b3244331474d44d0e61fb4d9cccb30`; this is a normal forward
commit, not a history rewrite.

## Retained infrastructure and security

- Fork-owned GitHub workflows and Windows installer artifact uploads.
- Upstream sync now stops on conflicts, validates the merged tree and opens a PR.
  It explicitly dispatches platform CI instead of relying on GITHUB_TOKEN pushes.
  The repository must allow Actions to create pull requests.
- Existing ignore rules for local runtime, verification and attachment outputs.
- Current upstream security dependency overrides, with the fork's `ip-address`
  10.7.2 update. Lockfiles remain frozen in CI; audits remain release gates.
- Three narrowly reapplied CodeQL fixes from `b91b0b7`: exact ChatGPT origin
  comparisons, single-pass XML entity decoding and single-line public errors.

## Scope for subsequent changes

Model-picker changes are a separate commit. Older fork behavior is deliberately
left out of this baseline. Before porting any of it, compare the current upstream
implementation and cover the actual server/browser boundary. Candidates include
retained-turn editing, remount streaming, Windows file-link projection, multipart
headroom, rate-limit recovery and timeout headroom. The old implementations and
their tests remain available in the pre-reset history.

The Web-to-native model switch must be checked after installing the rebuilt
launcher in a fresh task. Source and CI results do not establish that the previous
encrypted-compaction failure is resolved in an existing live conversation.
