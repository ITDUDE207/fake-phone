# Building apps for fake-phone

An app is a folder of plain web files. Drop it in `Documents/FakePhone/Apps/<id>/` on the PC
running the phone and it appears in the app drawer (open the drawer again to refresh).
To uninstall, delete the folder (you can do that from the phone's Files app).

The fastest start: copy `Apps/hello/` (created for you on first run; source in `sample-apps/hello/`),
rename the folder, and edit `manifest.json`.

## manifest.json

```json
{
  "id": "hello",
  "name": "Hello",
  "version": "1.0.0",
  "entry": "index.html",
  "icon": "icon.svg",
  "permissions": ["toast", "storage"]
}
```

| field         | rules |
|---------------|-------|
| `id`          | required; lowercase letters, digits, `-`; max 40; **must equal the folder name** |
| `name`        | required; 1–30 characters (shown under the icon) |
| `version`     | optional string |
| `entry`       | optional, default `index.html`; path inside the folder |
| `icon`        | optional; png, jpg, gif, webp or svg inside the folder |
| `permissions` | optional list; unknown names make the app fail to load |
| `devUrl`      | optional; `http://localhost:<port>` of your dev server. Only used in Developer mode (below) |

A broken manifest shows a toast naming the folder and the problem.

## The sandbox

Apps run in a sandboxed iframe with an opaque origin:

- They can't touch the phone's UI, your Neon login, or other apps.
- **No network.** A Content-Security-Policy blocks `fetch`, XHR, WebSocket and remote scripts, styles, images and fonts.
  Everything must be inside your app folder.
- Relative `<link rel="stylesheet">`, `<script src>`, `<img src>` and CSS `url(...)` are inlined by the phone at launch.
  ES module `import`s between files are **not** supported yet; use one script file, or bundle first (Vite, esbuild).
- Images, fonts and media referenced from JS at runtime must be inlined as `data:` URLs.
- Inline `<script>` and `onclick=` handlers work.

## The `phone` API

Injected as `window.phone`. Every call returns a Promise and rejects with an `Error` on failure.

| call | permission | notes |
|------|------------|-------|
| `phone.toast(text)` | `toast` | shows a message at the bottom of the screen |
| `phone.fs.write(path, text)` | `storage` | writes a UTF-8 text file, creating folders; max 2 MB |
| `phone.fs.read(path)` | `storage` | returns the file's text |
| `phone.fs.list(path = "")` | `storage` | `[{ name, dir, size, modified }]` |
| `phone.fs.remove(path)` | `storage` | deletes a file or folder; `path` is required |
| `phone.identity.number()` | `identity` | the user's 10-digit phone number |
| `phone.identity.theme()` | `identity` | `"light"` or `"dark"` |
| `phone.messages.send(to, text)` | `messages.send` | `to` is a 10-digit number, `text` 1–1000 chars |

`storage` paths are relative to your app's private folder, `Documents/FakePhone/AppData/<id>/`.
Paths with `..`, `\`, `:` or other special characters are rejected. Apps can't see each other's data.

## Permissions

1. List what you need in `manifest.json`. Calling something you didn't declare rejects with a clear error.
2. The first time an app uses a permission, the phone asks the user to **Allow** or **Deny**. The answer is remembered.
3. Users can reset every answer in Settings → App permissions → Reset.

Ask for as little as you need.

## Developer mode

Settings → **Developer mode**. While it's on, an open app gets a **↻** button and a **Console** panel
(`console.log/info/warn/error`, uncaught errors and unhandled promise rejections; a badge counts errors
while the panel is closed). Two ways to get live reload:

1. **Watch the folder.** The phone checks the app's folder every second and reloads when any file
   changes (manifest changes included). Nothing else to run.
2. **Use your own dev server.** Put `"devUrl": "http://localhost:5173"` in `manifest.json`. The phone loads
   your server inside the app frame, so Vite/esbuild/anything with hot reload works, including ES modules.
   Your page must include the SDK itself: copy `src/sdk/phone-sdk.js` next to it and add
   `<script src="phone-sdk.js"></script>`. If the phone doesn't hear from the SDK within 4 seconds the console says so.

`templates/dev-app/` has both: copy it into `Apps/`, run `node serve.mjs` in it (a zero-dependency server
that live-reloads on save), and open it.

Dev-server mode is **not** network-sandboxed (your dev server needs the network, and hot reload uses it).
It runs on its own origin, so it still can't touch the phone itself, and the `phone` API is permission-checked
exactly the same. With Developer mode off, `devUrl` is ignored and the folder's files run in the normal
sandbox, which is how your users will run the app, so test that before you ship.

`devUrl` must be `http://localhost:<port>` or `http://127.0.0.1:<port>`, and not the phone's own address.

## Limits of v1 (planned next)

- Folder install only (no `.fpapp` zip yet).
- Text files only through `phone.fs`.
- No background running, notifications from apps, or app-to-app messaging.

## The App Store

Open **App Store** in the drawer (you need to be signed in). **Browse** lists approved apps; **Get** installs
one into `Apps/<id>/` and it appears in the drawer. **Update** appears when a newer approved version exists,
and **Remove** deletes the app (its saved data stays in `AppData/<id>/`).

### Publishing your app

1. Build and test your app in `Apps/<id>/` (Developer mode helps).
2. App Store → **+ Publish**, pick the app, add a one-line description.
3. It's checked on your phone first. Allowed: html, js, css, json, txt, md, svg, png, jpg, gif, webp, woff, woff2, ttf;
   at most 60 files and 1 MB in total; no dot-files or `node_modules`; entry file must exist.
   `devUrl` is removed automatically: a published app always runs from its own files.
4. It shows as **pending** under *My apps* until an admin approves it. To ship a new version, publish again
   from the same app id. An app id belongs to whoever submitted it first.

What people see before installing: your phone number, the description, and exactly which permissions the app
declares. Permissions are still asked at runtime, and every store app runs in the same sandbox as any other app.

### Reviewing (admins)

Admins get a **Review** tab. **Try it** installs a pending app on your phone so you can use it, and you can open
its folder with Files → *Show on PC* to read the code. Then **Approve** or **Reject**. Read the code: the sandbox is
the safety net, not the first line of defence.
