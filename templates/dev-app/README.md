# Dev app template

1. Copy this whole folder to `Documents/FakePhone/Apps/my-app/` (the folder name must match `id`
   in `manifest.json`; rename both if you like).
2. In that folder run `node serve.mjs` (needs Node 18+). It serves the app and live-reloads on save.
3. On the phone: Settings → turn on **Developer mode**, then open **My App** from the app drawer.
   You get a **↻** reload button and a **Console** panel showing `console.log` output and errors.

No server? Developer mode also works with plain folders: the phone watches the app folder and
reloads when you save a file. Delete `devUrl` from `manifest.json` for that.

`devUrl` is only used while Developer mode is on. With it off, the phone runs the files in the
folder in the normal sandbox (no network), which is how users will run your app, so test that too.
