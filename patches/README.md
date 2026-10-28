<!-- These patches are derived from published omp package source and declarations; they are not patches from Pi or an official omp GUI. -->

# omp package patches

Each `*.patch` is a Bun `patchedDependencies` patch for the matching published `@oh-my-pi/*` package version. The base is that published package's `src/` and `dist/types/`; the changed side is omp fork source plus emitted declaration files. These patches are required integration changes for omp-console and are not an official omp or Pi distribution.

Regenerate the pinned set with `bun scripts/regen-patches.ts '<omp-fork-checkout>' <version>` after building the fork packages. See [CONTRIBUTING.md](../CONTRIBUTING.md#regenerate-omp-patches) for the upgrade procedure.
