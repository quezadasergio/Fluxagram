# Fluxagram

Multi-column desktop client for Instagram, with the same architecture as [FluxDeck](https://github.com/quezadasergio/FluxDeck): **Electron** (native Chromium), React, and an isolated session per account. Each column loads the mobile version of instagram.com.

Requirements: **Node.js 20+**, Windows / macOS / Linux.

## Development

```sh
npm install
npm run dev
```

Settings are stored in:

- macOS / Linux: `~/.config/Fluxagram/settings.json`
- Windows: `%APPDATA%\Fluxagram\settings.json`

Each account uses a persistent Electron partition (`persist:fluxagram-<id>`).

## Usage

1. **No session** — Instagram’s login page is shown. The username is detected automatically.
2. **Add account** — opens another login, in its own partition.
3. **Add column** — pick an account and a type: Feed, Messages, Reels, Explore, Profile, Notifications, Stories, or an instagram.com URL.
4. **Publish** — the **+** button on each column opens the create-post flow.
5. **Download** — the **↓** button accepts a post or reel link and saves the photo or video.
6. **Refresh** — ↻ reloads every column.
7. **About** — **i** shows the version and credit.

The version lives in [`shared/version.ts`](shared/version.ts) (`APP_VERSION`).

Columns can be reordered (‹ ›) or closed. The layout is saved in `settings.json`.

## Packaging

```sh
npm run dist:mac
npm run dist:win
npm run dist:linux
```

Installers are written to `release/`.
