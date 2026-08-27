# SakuraFall Architecture

## Product boundaries

SakuraFall is a desktop anime client. Catalog metadata, filtering, ranking,
schedule, ratings, and subject identity are owned by a multi-source metadata layer
(Bangumi as primary, AniList as automatic fallback). Playback sources are replaceable providers and do
not own the main catalog. The renderer never depends on one concrete video-source API.

## Runtime layers

1. Renderer domain UI
   - `AnimeZone` coordinates the catalog page.
   - `AnimeCatalogToolbar` owns filters and sorting controls.
   - `AnimeCatalogGrid` owns the virtualized card list.
   - `subjectDetailCoordinator` merges subject metadata with provider episodes.
2. Preload bridge
   - Exposes narrow IPC methods through `window.electronAPI`.
   - Renderer data must be serializable; Electron objects never cross this boundary.
3. Main-process services
   - `SubjectService` and `SubjectIndexService` own catalog/index behavior.
   - `SourceProviderRegistry` normalizes CMS, XPath, local, WebDAV, Jellyfin, and Emby providers.
   - `MediaLibraryService` indexes personal media libraries without exposing local filesystem paths to the renderer.
   - `SharePageResolverService` executes constrained resolver declarations from source packs.
   - `PlaybackResolverService` resolves the selected normalized episode.
   - `CustomizationPackService` installs and validates source/theme packs.
4. Persistence and network
   - SQLite stores metadata and stale-while-offline caches.
   - `NetworkPolicyService` keeps Bangumi routing independent from playback routing.
   - `ImageCacheService` supplies resized local cover thumbnails.

## Extension model

Source packs and theme packs are data artifacts, not application code. Bundled packs live
under `extensions/bundled` in development and `resources/extensions` outside ASAR after packaging;
installed packs live under Electron `userData`. Pack formats,
templates, update metadata, and asset slots are documented in `docs/EXTENSION_PACKS.md` and
`extensions/`.

Themes can define tokens, mascot/brand/loading/cursor assets, and constrained layout presets.
They cannot inject scripts or arbitrary Vue components. This keeps customization portable and
keeps the renderer security boundary intact.

The core starts with empty CMS, XPath, media-library, and resolver registries. `CustomizationPackService`
activates bundled and user-installed artifacts after Electron resolves runtime paths. No main-process
service may import a concrete site adapter or contain a playback-source domain.

## Performance contract

Budgets are versioned in `src/shared/performance-budgets.json` and validated by
`tests/performance-budget.test.mjs`. The catalog grid uses bounded virtualization, stable card
dimensions, cached thumbnails, passive scroll listeners, and scroll-only frame sampling.
Feature work that exceeds a budget must either reduce its hot-path cost or update the budget
with an explicit reason.

## Compatibility policy

Legacy CMS IPC methods remain available for existing user configuration files while screens migrate
to `SourceProviderRegistry`. Historical source ids in favorites and playback history remain readable,
but new renderer work must use unified provider or playback resolver APIs.
