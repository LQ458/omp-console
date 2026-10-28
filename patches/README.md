<!-- These patches are derived from published omp packages; they are not patches from Pi or an official omp GUI. -->

# omp package patches

Each versioned `*.patch` is a Bun `patchedDependencies` patch for that exact published `@oh-my-pi/*` release. The patch base is the npm tarball's `src/` and `dist/types/`; the retained changes are the omp-console integration hooks. They are not patches from a fork and are not an official omp or Pi distribution.

Sync a new published release without an omp fork checkout:

```sh
bun scripts/sync-omp.ts <version|latest> --report .omp-sync-report.md
```

The script uses the registry recorded in `bun.lock`, merges the current patched release onto the target, takes generated catalog JSON from upstream, updates package versions and `bun.lock`, and writes adjacent Markdown/JSON reports. Store intentional conflict choices in `resolutions/<version>/<package>/<path>`; unresolved conflicts stop the sync. Review `LEDGER.md` for each old patch file's kept, resolved, or dropped decision and its console code path/test. See [CONTRIBUTING.md](../CONTRIBUTING.md#sync-published-omp-packages) for the full procedure.
