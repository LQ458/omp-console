# Contributing

## Setup

The daemon host is macOS. Install Bun 1.4.3 and `omp`; sign in to `omp` before starting real sessions. In a checkout:

```sh
bun install --frozen-lockfile
./scripts/install.sh
```

The installer requires Bun 1.4 or newer, puts that Bun first on `PATH` for package scripts, and builds `packages/web/dist`; `bun run build` itself refuses an older Bun (`packages/web/scripts/check-bun.ts`). It does not load LaunchAgents unless `--launchd` is supplied. For Android dependencies, run `npm ci` in `apps/android` and use its checked-in Gradle wrapper. Do not commit generated build output or dependency directories.

The repository started under the internal codename **deck**. Public product and package names are omp-console; use those names in new user-facing text.

## Checks

```sh
cd packages/web && bun test && bun run check:types && bun run build
cd packages/daemon && bun test --max-concurrency=4 && bun run check:types
cd packages/session-host && bun test --max-concurrency=4 && bun run check:types
```

CI runs these checks on one Linux runner (plus the personal-data scan and gitleaks). It does not run macOS: before a release, run them on a Mac too, and `cd apps/mac && cargo test` for the macOS shell. Android's JavaScript tests are `cd apps/android && npm test`; Gradle tests require the Android SDK and JDK 21.

## Regenerate omp patches

The published package tree in `node_modules` is the clean base for the pinned omp release. The patch generator reverses the current patch (when one exists for that exact version), then compares the clean published `src/` and `dist/types/` with the fork's `src/` and emitted declaration files. It requires all six fork packages to have been built before invocation.

```sh
bun install --frozen-lockfile
# In the omp fork checkout, build the packages and emit dist/types/*.d.ts.
bun scripts/regen-patches.ts '<omp-fork-checkout>' 18.12.6
```

The generator validates all package versions and computes every patch before writing any of them. Review the resulting patch files and verify a fresh `bun install --frozen-lockfile` applies them. It does not change `package.json` or `bun.lock`.

## Upgrade the pinned omp release

1. Select the intended published omp version and matching fork revision. Update the omp entries in `workspaces.catalog` and `patchedDependencies` in the root `package.json` to that version and the corresponding new patch paths.
2. Run `bun install` to update `bun.lock` and install the unpatched published package artifacts for the new version. Keep this lockfile change in the upgrade commit.
3. Build the matching fork packages so `src/` and emitted `dist/types/` are present, then run the patch generator with the fork checkout and new version.
4. Review all six generated patches, run the full package checks, regenerate third-party notices, and commit the lockfile, patch set, and documentation together.

The old patch is used as a reverse only when its key exactly matches the requested version. A new version therefore starts from the published package tree, not an older patched release.

## Third-party notices

Run `bun scripts/gen-licenses.ts` after `bun install --frozen-lockfile`. It reads the Bun lockfile and installed workspace packages, resolves macOS Cargo metadata and Android npm/Gradle dependencies, then writes `licenses/THIRD-PARTY-NOTICES.md` and `packages/web/public/licenses.txt`. The Android dependencies are synchronized as needed; Cargo and Gradle may fetch their pinned metadata on first use. Run it twice and confirm the outputs do not change.
