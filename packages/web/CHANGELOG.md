# Changelog

## [Unreleased]

### Added
- Session-scoped sheets can float, resize, and maximize over the deck workspace on desktop.
- Phone Actions shows up to ten next-step suggestions and twenty ranked actions, with truncated suggestions editable in the composer.
- The composer and Cmd+K route `/tan`, `/omfg`, and `/cleanse` to native panels; Tan results link to Agents, OMFG rules require review before saving, and Cleanse shows repair progress with cancellation.
- Skills and Git session panels and browser-based WebM recording for session display capture.
- The session header and phone list expose loop progress and a stop control, plus a Vibe mode toggle; `/loop` and `/vibe` work from ⌘K and the composer.
- `/debug` adds Diagnostics and DAP sessions tabs; `/live` uses browser-owned WebRTC audio and stops capture when the page is hidden or the sheet closes.
- Recent project folders come from saved omp sessions; terminal sessions appear in the sidebar and open as copies, while transcripts remain readable after their project folder is deleted.

### Changed
- Added native pause, queue, restart, collaboration, and browser-only command controls to the composer, command palette, and phone Actions panel.
- Remote-debugger startup requires confirmation with an unauthenticated local code-execution warning; diagnostic action buttons wrap on phones.
- Optional librarian, agenda, quick-ask, and peer UI follows daemon capabilities; collaboration links are view-only by default, and offline transcript caching stays disabled until enabled in settings.

### Fixed
- Floating panels keep their menus and other panes usable; resizing preserves the opposite edge.
- Quick-reply generation keeps completed suggestions when it reaches the output limit.
- Skill approvals list install scripts before allowing execution and are tied to their operation; Git diffs highlight added/removed lines and keep hunk actions with their hunks; closing a recording sheet saves the video.
