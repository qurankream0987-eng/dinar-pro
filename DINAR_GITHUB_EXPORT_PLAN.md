# DINAR sanitized GitHub export plan

## Source refs to preserve

The source repository remains the canonical local copy and must not be rewritten.
The export should carry only these requested development refs:

| Source ref | Source commit at plan time | Export commit |
| --- | --- | --- |
| `google-development` | `7666ddfae3ad17b207f08bdc832d49dd7d5c71d0` | Not generated |
| `feature/dinar-next-google` | Current local branch; includes security changes after `294719971b643e14c9f015d32ec292498e83b5a2` | Not generated |

The private destination has not been selected, so no export history has been
created or transformed.

## Sensitive history finding

The paths `.opencode/opencode.db`, `.opencode/opencode.db-wal`, and
`.opencode/opencode.db-shm` occur in the history beginning at commit
`6a69d5a687fbb13b9a41d426285142cbd10b961a`. A local read-only audit found stored
conversation messages. Treat those messages as private even though the scan did
not find common credential or contact-detail patterns.

## Isolated export procedure

After the owner selects the destination and approves the sanitized-export plan:

1. Make a separate, no-hardlink clone of the unchanged source repository in a
   dedicated export directory. Do not run history filtering in the source.
2. Fetch only `google-development` and `feature/dinar-next-google` into that
   clone. Keep production/protected refs out of the export.
3. Remove only the three SQLite database/journal paths above from every commit
   in that export's selected refs using a verified history-filtering tool.
4. Save the tool's complete old-commit-to-new-commit map and record the
   old-to-new tip for each exported branch in a manifest outside the repository
   content. No user conversation text or database bytes belong in that map.
5. Verify the exported commit trees contain none of the three paths, rerun the
   local secret scan and dependency audit against the export, then compare the
   source and export trees at each branch tip. All differences must be limited
   to those removed paths.
6. Push only after the private repository and destination branches are confirmed
   by the owner. Never force-push or push the unfiltered source history.

Filtering changes exported commit IDs. Branches recreated from source after the
mapping is made must be re-filtered, because the new commits could reintroduce
the SQLite files.

## Restoration

The source repository remains unchanged and is the authoritative restoration
source. To return to the original history, use the source branch refs
`google-development` and `feature/dinar-next-google` from the original local
repository. Do not fetch the unfiltered source refs into the sanitized export
repository: that would reintroduce the private database history.

For an export commit that needs tracing, use the saved commit map to locate its
source commit. To restore missing source files or commits, make a separate
working clone from the original source repository; do not reverse the filter in
the sanitized export repository.

## Current status

- Safe method and consequences are documented.
- Actual history transformation: not performed.
- Source history: untouched.
- Export commit map: not generated.
- Private GitHub destination: awaiting owner selection.
- Push: not authorized.
