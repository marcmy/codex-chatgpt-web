The launcher pins minimatch 11.0.3 to address GHSA-g3hv-75wg-m249. Existing packaging dependencies still use older minimatch APIs, so Bun applies three compatibility patches:

- ASAR and dir-compare call the named `minimatch` export.
- glob reads each component matcher's `pattern` and calls `test`, retaining its existing asynchronous and synchronous traversal APIs.

`tests/packaging-globs.test.cjs` covers ASAR roundtrips and unpack rules, include/exclude filters, traversal, unmatched patterns, filelist matching, and bounded adversarial preprocessing. Remove these patches when the parent packages support the patched minimatch API directly.
