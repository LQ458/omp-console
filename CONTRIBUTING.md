# Contributing

## Setup

Use a macOS, Linux, or Windows 10/11 x64 host. Install Bun 1.4.3 and `omp`; sign in to `omp` before starting real sessions. The setup commands below are for macOS/Linux; Windows instructions follow.

**macOS/Linux:**

```sh
bun install --frozen-lockfile
./scripts/install.sh
```

The installer requires Bun 1.4 or newer, puts that Bun first on `PATH` for package scripts, and builds `packages/web/dist`; `bun run build` itself refuses an older Bun (`packages/web/scripts/check-bun.ts`). It does not load LaunchAgents unless `--launchd` is supplied. For Android dependencies, run `npm ci` in `apps/android` and use its checked-in Gradle wrapper. Do not commit generated build output or dependency directories.

On Windows, use PowerShell and Git for Windows, then run `.\scripts\install.ps1`; it installs and starts the per-user Scheduled Task. No WSL is required. CI typechecks and tests the Windows daemon, session-host, and web packages on `windows-latest`.

The repository started under the internal codename **deck**. Public product and package names are omp-console; use those names in new user-facing text.

## Checks

```sh
cd packages/web && bun test && bun run check:types && bun run build
cd packages/daemon && bun test --max-concurrency=4 && bun run check:types
cd packages/session-host && bun test --max-concurrency=4 && bun run check:types
```

CI runs these checks on Linux and Windows, including Windows-native typechecking and all three test suites. See the Windows job in `.github/workflows/ci.yml` for its PowerShell commands. CI does not run macOS: before a release, run them on a Mac too, and `cd apps/mac && cargo test` for the macOS shell. Android's JavaScript tests are `cd apps/android && npm test`; Gradle tests require the Android SDK and JDK 21.

## Sync published omp packages

omp-console consumes published `@oh-my-pi/*` packages and keeps only the console integration patches in `patches/`. No omp fork checkout or local package build is required.

```sh
bun install --frozen-lockfile
bun scripts/sync-omp.ts 18.13.2 --from 18.12.6 --report .omp-sync-18.13.2.md
```

For the registry's current `latest` release:

```sh
bun scripts/sync-omp.ts latest --report .omp-sync-latest.md
```

The script reads the package registry from `bun.lock` (override with `--registry <url>`), downloads and integrity-checks the old and target package tarballs, applies the current patch to the old published tree, then three-way merges that result onto the target. Generated `models.json` and `compat/rules.json` always come from the target tarball. Record reviewed decisions under `patches/resolutions/<version>/<package>/<path>` in one of two forms: a `# omp-sync-resolution v1` file (per-conflict `ours`/`theirs` choices, optionally followed by a `--- patch ---` diff) for conflicted files, or the complete final file content, which applies whether or not the file conflicts (use it for line-level drops in cleanly merged files). Unresolved conflicts exit non-zero and still write the Markdown and JSON report. A committed patch must equal the script's output from the previous release's patch plus the committed resolutions.

A full-content resolution needs a sibling `<path>.ours.sha256` holding the SHA-256 of the patched old file it was reviewed against (`absent` when that file did not exist); the sync stops if the source patch has changed since, so a reviewed file can never silently replace a newer edit. Resolutions apply only when moving to a new version, and the script warns about any resolution it did not use.

On success, the script updates `workspaces.catalog`, `patchedDependencies`, the versioned patch files, and `bun.lock` via `bun install`. It removes patches that become empty. Re-running against its own output must be a no-op. Review the report and `patches/LEDGER.md`, verify changed declarations against source, and run the package checks before committing the version, lockfile, patches, resolutions, and ledger together.

The sync report writes both formats beside the requested path (for example, `.omp-sync-18.13.2.md` and `.omp-sync-18.13.2.json`). Never copy a fork diff forward by hand; preserve only console integration that the ledger ties to a live console path and test.

## Releases

1. Set the same version in `apps/mac/tauri.conf.json` and `apps/mac/Cargo.toml`. The Windows MSI accepts only numeric versions (`major.minor.patch`, optionally `-<number>`), so do not use `-beta` style suffixes.
2. Write the release notes in `docs/releases/v<version>.md`.
3. Optionally run the [Release workflow](.github/workflows/release.yml) by hand first; it builds every package as workflow artifacts without creating a release.
4. Push the tag `v<version>`. The workflow checks that the tag matches the app version and the notes exist, builds the macOS, Windows, and Linux apps, writes `SHA256SUMS.txt`, and creates a **draft** pre-release.
5. Download and try the assets, then publish the draft on GitHub.

## Third-party notices

Run `bun scripts/gen-licenses.ts` after `bun install --frozen-lockfile`. It reads the Bun lockfile and installed workspace packages, resolves macOS Cargo metadata and Android npm/Gradle dependencies, then writes `licenses/THIRD-PARTY-NOTICES.md` and `packages/web/public/licenses.txt`. The Android dependencies are synchronized as needed; Cargo and Gradle may fetch their pinned metadata on first use. Run it twice and confirm the outputs do not change.
