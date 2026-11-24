# hig-web-kit (vendored)

`hig.css` and `components.css` from [pavelprokes/hig-web-kit](https://github.com/pavelprokes/hig-web-kit)
v0.3.0, commit `fecdfc5951afc6b8d8b4cf7e79663bebc11f7a8c` (`dist/`), MIT (see `LICENSE`, `NOTICE.md`).

Vendored instead of installed: the `github:` dependency was fetched as a codeload tarball, which cloud sessions
cannot download (403), so `pnpm install` failed there. Do not edit these files; app styles go to
`src/app/globals.css`.

To update: copy `dist/hig.css` and `dist/components.css` of the new commit here, change the commit above, and run
`pnpm a11y` (WCAG 2.2 AA, light and dark).
