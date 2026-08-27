# SakuraFall Release Checklist

## 0. Public repository gate

- Confirm `LICENSE`, `README.md`, `CONTRIBUTING.md`, and `SECURITY.md` are current.
- Scan the working tree and Git history for credentials, local databases, logs, and absolute machine paths.
- Remove historical user data before changing repository visibility; ignoring a file does not remove old commits.
- Keep agent handoff notes, local reference repositories, generated installers, and unused asset iterations out of the public tree.
- Confirm bundled assets and extension packs have redistribution-compatible licenses.

## 1. Freeze

- Stop architecture changes after the release-candidate branch is cut.
- Confirm `package.json` version and release notes.
- Confirm source packs contain configuration only and no application secrets.
- Confirm theme assets and source-pack licenses permit redistribution.

## 2. Automated gate

Run from a clean terminal with the development Electron process closed:

```powershell
npm ci
npm run lint
npm run verify:release
```

`verify:release` must pass all of the following:

- Unit and regression tests.
- Renderer production build and bundle budgets.
- Windows unpacked application build.
- Packaged preload/IPC/provider/theme/database smoke test.
- Packaged offline-shell smoke test.
- Packaged startup-time budget.

## 3. Data integrity

- Start once with a copy of the previous release database.
- Confirm a `.pre-v*-to-v*.backup` file is created before migration.
- In Settings, run `健康检查`; integrity must be `ok` and schema must match the expected version.
- Verify favorites, recent playback history, last episode, and playback position remain intact.
- Check a multi-line 12-episode title still displays 12 episodes, not 24.

## 4. Desktop workflows

- Browse latest, popular, type, year, search, and pagination views.
- Open schedule and trending modules and confirm covers render.
- Open details and verify a low-confidence source is not automatically selected.
- Play, seek, pause, change episode, change line, enter fullscreen, and reopen playback history.
- Verify proxy/TUN policies with Bangumi through proxy and video sources direct.
- Install, update, remove, export, and re-import one source pack and one theme pack.
- Test the main and player windows at 800x600, 1200x800, 1920x1080, and 150% Windows scaling.

## 5. Installer

- Build the NSIS installer with `npm run build:electron`.
- Install for the current user without administrator rights.
- Verify Start Menu and desktop shortcuts, taskbar icon, uninstall, and reinstall-over-existing-version.
- Verify the installed build starts with network disconnected and cached catalog/favorites remain available.
- Sign the installer and executable before public distribution. Code signing requires an external Windows certificate and cannot be replaced by a repository change.

## 6. Release metadata

- Publish installer SHA-256 and file size alongside the release.
- Update the hosted `latest.json` using `docs/latest.example.json`.
- Use HTTPS for both update metadata and download URL.
- Archive the release test output and known limitations.

## 7. Rollback

- Keep the previous signed installer available.
- Never delete user databases during uninstall or rollback without explicit confirmation.
- If a migration issue is found, stop distribution and restore from the generated pre-migration backup.
