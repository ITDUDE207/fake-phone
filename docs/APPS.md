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

## Limits of v1 (planned next)

- Folder install only (no `.fpapp` zip yet).
- No hot-reload dev mode; reopen the app after editing.
- Text files only through `phone.fs`.
- No background running, notifications from apps, or app-to-app messaging.
