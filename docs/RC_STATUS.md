# Release Candidate Status

## Acceptance snapshot (2026-07-13)

- ESLint completed with zero errors.
- 89 unit and regression tests passed.
- Production renderer build and bundle budgets passed.
- Packaged startup: 547 ms online and 385 ms offline (10,000 ms budget).
- Installed startup: 725 ms online and 512 ms offline.
- The packaged and installed app loaded 10 external playback providers, 3 themes, and all 8 default theme asset slots.
- Installer install, database bootstrap, offline launch, and uninstall passed.
- Desktop list scroll sampled at 120 FPS with a 5.59 ms average frame and no long frames.
- Real playback, progress-track click, and progress-thumb drag were verified against a live stream.
- Installer SHA-256: `DC24F8FA1EF7D21E78318AD252E8E1BD045CB94DA2561F15D26F9E398B287759`.

## Automated acceptance

- Unit/regression tests: required.
- ESLint: required with zero errors.
- Renderer production build: required.
- Bundle and startup performance budgets: required.
- Packaged Windows online/offline smoke tests: required.
- SQLite integrity and schema version: required.

## Protected product behavior

- Alternate playback lines use the longest line as the episode count.
- Search results are ranked per candidate; unreliable matches are not auto-expanded.
- Database changes are versioned, transactional, and backed up before migration.
- Runtime errors are written as bounded, redacted JSONL diagnostics.
- A renderer crash reloads once; repeated crashes stop automatic reload loops.
- A second app launch focuses the existing desktop window.

## External release dependency

The generated installer is suitable for internal release-candidate testing but is unsigned.
A trusted Windows code-signing certificate is still required before broad public distribution.
