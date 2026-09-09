# AIO UI Compatibility

`dsh-aio-ui-compat` 1.0.0 exports `ImageGallery`, `MessageText`,
`isAppendSurfaceEvent`, and `isReplacementSurfaceEvent` from its client module.
The host is a no-op; there are no routes, tools, filesystem access, or privileged
APIs. The client `apply` owns injected styles through Cordis effect disposal.
Consumers must load/enable the plugin before rendering its exports.

## Gallery Contract

Compared against the installed `@deepseek-ai/dsh-client-ui-attachment`
0.1.1-rc.2 `lib/types/MessageImage.d.ts` and `lib/client.js`:

| Prop | Old | Pinned upstream |
| --- | --- | --- |
| `images` | readonly `{ attachment: ImageAttachmentRef }[]` | Same durable arm, plus `{ preview: { url, name?, width?, height? } }` |
| `load` | `(attachment) => Promise<string>` | Same, plus optional `peek(attachment)` |
| `align` | `'start' \| 'end'` | Unchanged |
| `labels` | `image`, `open`, `openNamed(label)`, `loading`, `loadFailed`, `lightbox: { dialog, close }` | Unchanged |
| `compact` | Absent | Optional boolean, default false |

Old gallery props are accepted unchanged; this is not a claim of identical
internal implementation. The bundled gallery is the current upstream source,
including cache peek, local previews, retry/liveness guards, sizing and portal
lightbox. No compatibility export for the old `MessageImage` is provided.

`MessageText({ text })` is intentionally a plain React `div`, never Markdown.
The old 0.1.1-rc.2 frontend implementation was
`jsx('div', { className: css.text, children: text })`; its CSS used `pre-wrap`,
`break-word`, and inherited font size/line height. These semantics are retained,
including literal Markdown/HTML and multiline text. CSS class names are private.

## Build

From the repository root:

```powershell
node scripts/build-aio-ui-compat.mjs --upstream <pinned-upstream-checkout>
node --test test/aio-ui-compat.test.mjs
```

The builder requires HEAD `c389f96bf3a9b6807cb71ed6bdad5849be0df6d8`,
checks the four gallery source/CSS files and LICENSE against that commit, and
bundles committed contents without changing the checkout. It uses
`tauri-app/node_modules/esbuild`, CSS modules, and the installed session surface
subpath (not removed client exports). React, React DOM, and UI primitives remain
host-provided externals. The generated asset has no source paths or source maps.
`PROVENANCE.json` records source hashes and the installed session version.

The browser test uses real React and the upstream close icon, plus headless Edge
through the existing Playwright runtime convention. `DSH_AIO_COMPAT_UPSTREAM` and
`DSH_AIO_COMPAT_PLAYWRIGHT` override their local locations.

This package does not register itself in the companion registry, rewrite
consumer imports, or change seed/release builders.
