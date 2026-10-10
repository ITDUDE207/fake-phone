import { getCurrentWindow } from "@tauri-apps/api/window";
import { createClient } from "@neondatabase/neon-js";
import { invoke } from "@tauri-apps/api/core";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import sdkSrc from "./sdk/phone-sdk.js?raw";
import helloManifest from "../sample-apps/hello/manifest.json?raw";
import helloHtml from "../sample-apps/hello/index.html?raw";
import helloJs from "../sample-apps/hello/app.js?raw";
import helloCss from "../sample-apps/hello/style.css?raw";
import helloIcon from "../sample-apps/hello/icon.svg?raw";

const $ = <T extends HTMLElement>(sel: string) => document.querySelector<T>(sel)!;
const view = $("#view");
// Incoming text is untrusted: always escape before putting it in HTML.
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const load = <T>(k: string, d: T): T => {
  try { return JSON.parse(localStorage.getItem(k) ?? "null") ?? d; } catch { return d; }
};
const save = (k: string, v: unknown) => {
  try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* storage unavailable */ }
};
const digits = (n: number) => Array.from(crypto.getRandomValues(new Uint32Array(n)), (x) => x % 10).join("");
const fmt = (n: string) => `${n.slice(0, 3)} ${n.slice(3, 6)} ${n.slice(6)}`;
const hm = (t: number) => new Date(t).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
const NUM = /^\d{10}$/;

// ---- Neon: sign-in, phone number, and messages live in the cloud database ----
const AUTH_URL = import.meta.env.VITE_NEON_AUTH_URL as string | undefined;
const DATA_URL = import.meta.env.VITE_NEON_DATA_API_URL as string | undefined;
const client = AUTH_URL && DATA_URL ? createClient({ auth: { url: AUTH_URL }, dataApi: { url: DATA_URL } }) : null;

let user: { id: string; email: string } | null = null;
let myNum = "";

type Msg = { id: string; out: boolean; text: string; ts: number; st?: "sending" | "sent" | "failed" };
let threads = load<Record<string, Msg[]>>("threads", {});
let unread = load<Record<string, number>>("unread", {});
let cursor = load<number>("cursor", 0);
const seen = new Set<string>(Object.values(threads).flatMap((l) => l.map((m) => m.id)));
const last = (p: string) => threads[p][threads[p].length - 1];

function add(peer: string, m: Msg) {
  const l = (threads[peer] ??= []);
  l.push(m);
  if (l.length > 500) l.shift();
  save("threads", threads);
}

function setOnline(v: boolean) {
  $("#carrier").textContent = v ? "FakeNet" : "No modem";
}

// Find or create this account's phone number (one per account, never changes).
async function ensureProfile(): Promise<boolean> {
  const got = await client!.from("profiles").select("number").maybeSingle();
  if (got.error) { toast(got.error.message); return false; }
  if (got.data) { myNum = (got.data as { number: string }).number; return true; }
  for (let i = 0; i < 6; i++) {
    const n = "555" + digits(7);
    const ins = await client!.from("profiles").insert({ number: n }).select("number").single();
    if (!ins.error) { myNum = n; return true; }
    if (ins.error.code !== "23505") { toast(ins.error.message); return false; } // 23505: number already taken
  }
  toast("Couldn't get a phone number. Try again.");
  return false;
}

type Row = { id: number; from_number: string; to_number: string; body: string; created_at: string };
let polling = false;
async function poll() {
  if (!client || !user || !myNum || polling) return;
  polling = true;
  try {
    const notify = cursor > 0;
    const r = await client
      .from("messages")
      .select("id, from_number, to_number, body, created_at")
      .gt("id", Math.max(0, cursor - 20)) // small overlap in case rows commit out of order
      .order("id", { ascending: true })
      .limit(200);
    if (r.error) return setOnline(false);
    setOnline(true);
    let changed = false;
    for (const row of (r.data ?? []) as Row[]) {
      cursor = Math.max(cursor, row.id);
      const id = String(row.id);
      if (seen.has(id)) continue;
      seen.add(id);
      const out = row.from_number === myNum;
      const peer = out ? row.to_number : row.from_number;
      add(peer, { id, out, text: row.body, ts: Date.parse(row.created_at), st: out ? "sent" : undefined });
      changed = true;
      if (!out && cur() !== "thread:" + peer) {
        unread[peer] = (unread[peer] ?? 0) + 1;
        if (notify) toast(`New message from ${fmt(peer)}`);
      }
    }
    save("cursor", cursor);
    if (changed) {
      save("unread", unread);
      if (cur() === "messages") show("messages", false);
      drawBubbles();
      refreshBadge();
    }
  } catch {
    setOnline(false);
  } finally {
    polling = false;
  }
}

async function sendMsg(peer: string, text: string): Promise<boolean> {
  const r = await client!
    .from("messages")
    .insert({ from_number: myNum, to_number: peer, body: text })
    .select("id, created_at")
    .single();
  if (r.error) {
    toast(r.error.code === "42501" ? "That number doesn't exist" : r.error.message);
    return false;
  }
  const row = r.data as { id: number; created_at: string };
  seen.add(String(row.id));
  cursor = Math.max(cursor, row.id);
  save("cursor", cursor);
  add(peer, { id: String(row.id), out: true, text, ts: Date.parse(row.created_at), st: "sent" });
  drawBubbles();
  return true;
}

async function signedIn(u: { id: string; email: string }) {
  user = u;
  if (!(await ensureProfile())) { user = null; return show("auth", false); }
  stack = ["home"];
  show("home", false);
  void poll();
}

async function signOut() {
  await client?.auth.signOut();
  user = null;
  myNum = "";
  threads = {};
  unread = {};
  cursor = 0;
  seen.clear();
  for (const k of ["threads", "unread", "cursor"]) localStorage.removeItem(k);
  setOnline(false);
  show("auth", false);
}

async function authenticate(mode: "signin" | "signup") {
  const email = $<HTMLInputElement>("#email").value.trim();
  const password = $<HTMLInputElement>("#pw").value;
  if (!email || password.length < 8) return toast("Enter your email and a password (8+ characters)");
  const r =
    mode === "signup"
      ? await client!.auth.signUp.email({ email, password, name: email.split("@")[0] || "User" })
      : await client!.auth.signIn.email({ email, password });
  if (r.error) return toast(r.error.message ?? "Sign-in failed");
  const s = await client!.auth.getSession();
  const u = s.data?.user;
  if (!s.data?.session || !u) return toast("Check your email to verify, then sign in");
  await signedIn({ id: u.id, email: u.email });
}

// ---- Files: the phone's storage is a real folder on the PC (Documents/FakePhone) ----
const inTauri = "__TAURI_INTERNALS__" in window;
type Ent = { name: string; dir: boolean; size: number; ts: number };
let fsDir = ""; // current folder, "/"-separated, relative to the phone's storage
let fsEnts: Ent[] = [];
let fsFile = ""; // file open in the viewer
let fsUrl = ""; // blob URL of the image being viewed

const TEXT_EXT = new Set(["txt", "md", "json", "csv", "log", "js", "ts", "html", "css", "xml", "yml", "yaml", "ini", "toml", "rs", "py", "sql"]);
const IMG_EXT = new Set(["png", "jpg", "jpeg", "gif", "webp", "bmp", "svg"]);
const MAX_IMPORT = 50 * 1024 * 1024;
const MAX_TEXT = 2 * 1024 * 1024;

const joinPath = (a: string, b: string) => (a ? `${a}/${b}` : b);
const parentOf = (p: string) => p.split("/").slice(0, -1).join("/");
const baseOf = (p: string) => p.split("/").pop() ?? p;
const extOf = (n: string) => (n.includes(".") ? n.split(".").pop()!.toLowerCase() : "");
const bytes = (n: number) => (n < 1024 ? `${n} B` : n < 1048576 ? `${Math.round(n / 1024)} KB` : `${(n / 1048576).toFixed(1)} MB`);
const bad = /[\\/:*?"<>|\0]/;
const validName = (n: string) => !!n && n !== "." && n !== ".." && !bad.test(n) && n.length <= 100;
const taken = (n: string) => fsEnts.some((e) => e.name.toLowerCase() === n.toLowerCase());
function uniqueName(n: string) {
  if (!taken(n)) return n;
  const dot = n.lastIndexOf(".");
  const [stem, ext] = dot > 0 ? [n.slice(0, dot), n.slice(dot)] : [n, ""];
  for (let i = 2; ; i++) if (!taken(`${stem} (${i})${ext}`)) return `${stem} (${i})${ext}`;
}

async function call<T>(cmd: string, args?: Record<string, unknown>): Promise<T | null> {
  try { return await invoke<T>(cmd, args); } catch (e) { toast(String(e)); return null; }
}
// For commands that return nothing: true on success, toasts the error otherwise.
async function run(cmd: string, args: Record<string, unknown>): Promise<boolean> {
  try { await invoke(cmd, args); return true; } catch (e) { toast(String(e)); return false; }
}
async function writeBytes(rel: string, data: Uint8Array): Promise<boolean> {
  try {
    await invoke("fs_write", data, { headers: { "x-path": encodeURIComponent(rel) } });
    return true;
  } catch (e) { toast(String(e)); return false; }
}

// Small in-phone dialog. Resolves with the id of the button pressed and any input text.
function popup(inner: string): Promise<{ id: string; val: string }> {
  return new Promise((resolve) => {
    const m = document.createElement("div");
    m.className = "modal";
    m.innerHTML = `<div class="dlg">${inner}</div>`;
    const input = m.querySelector<HTMLInputElement>("input");
    const done = (id: string) => { const val = input?.value.trim() ?? ""; m.remove(); resolve({ id, val }); };
    m.addEventListener("click", (e) => {
      const t = e.target as HTMLElement;
      if (t === m) return done("no");
      const b = t.closest<HTMLElement>("[data-d]");
      if (b) done(b.dataset.d!);
    });
    m.addEventListener("keydown", (e) => {
      if (e.key === "Escape") done("no");
      else if (e.key === "Enter" && (e.target as HTMLElement).tagName === "INPUT") done("ok");
    });
    $("#screen").appendChild(m);
    if (input) { input.focus(); input.select(); }
  });
}
const askName = async (title: string, value: string, ok: string) => {
  const r = await popup(`<div class="title sm">${esc(title)}</div><input class="field" maxlength="100" autocomplete="off" value="${esc(value)}" />
    <div class="stack"><button class="btn wide" data-d="ok">${esc(ok)}</button><button class="btn wide ghost" data-d="no">Cancel</button></div>`);
  if (r.id !== "ok") return null;
  if (!validName(r.val)) { toast("That name isn't allowed"); return null; }
  return r.val;
};

async function fsLoad() {
  if (!inTauri) return drawFiles();
  const r = await call<[string, boolean, number, number][]>("fs_list", { rel: fsDir });
  if (!r) return;
  fsEnts = r.map(([name, dir, size, ts]) => ({ name, dir, size, ts }));
  drawFiles();
}

function drawFiles() {
  const box = document.getElementById("fslist");
  const crumbs = document.getElementById("fscrumbs");
  if (!box || !crumbs) return;
  const parts = fsDir ? fsDir.split("/") : [];
  crumbs.innerHTML =
    `<button data-fs="cd" data-path="">On My Phone</button>` +
    parts.map((p, i) => ` <span>›</span> <button data-fs="cd" data-path="${esc(parts.slice(0, i + 1).join("/"))}">${esc(p)}</button>`).join("");
  if (!inTauri) { box.innerHTML = '<p class="empty">Files lives on your PC, so it only works in the desktop app.<br />Run <b>npm run tauri dev</b>.</p>'; return; }
  box.innerHTML = fsEnts.length
    ? `<div class="card">${fsEnts
        .map((e) => `<div class="row"><button class="fsmain" data-fs="open" data-name="${esc(e.name)}">
            <span class="fsico ${e.dir ? "dir" : ""}">${e.dir ? icon("folder") : icon("file")}</span>
            <span class="grow">${esc(e.name)}<small>${e.dir ? "Folder" : bytes(e.size)}${e.ts ? " · " + new Date(e.ts).toLocaleDateString("en-GB", { day: "numeric", month: "short" }) : ""}</small></span></button>
            <button class="btn sm ghost" data-fs="menu" data-name="${esc(e.name)}" aria-label="More">⋯</button></div>`)
        .join("")}</div>`
    : '<p class="empty">This folder is empty.<br />Add a folder, a note, or import files from your PC.</p>';
}

async function fsMenu(path: string, isDir: boolean, fromViewer = false) {
  const name = baseOf(path);
  const r = await popup(`<div class="title sm">${esc(name)}</div><div class="stack">
    <button class="btn wide ghost" data-d="rename">Rename</button>
    <button class="btn wide ghost" data-d="show">Show on PC</button>
    <button class="btn wide danger" data-d="delete">Delete</button>
    <button class="btn wide ghost" data-d="no">Cancel</button></div>`);
  const parent = parentOf(path);
  if (r.id === "rename") {
    const n = await askName("Rename", name, "Rename");
    if (!n || n === name) return;
    if (await run("fs_rename", { from: path, to: joinPath(parent, n) })) fsAfter(fromViewer);
  } else if (r.id === "delete") {
    const c = await popup(`<div class="title sm">Delete “${esc(name)}”?</div><p class="note">${isDir ? "The folder and everything in it" : "This file"} will be deleted from your PC. This can't be undone.</p>
      <div class="stack"><button class="btn wide danger" data-d="ok">Delete</button><button class="btn wide ghost" data-d="no">Cancel</button></div>`);
    if (c.id !== "ok") return;
    if (await run("fs_delete", { rel: path })) fsAfter(fromViewer);
  } else if (r.id === "show") {
    const abs = await call<string>("fs_abs", { rel: path });
    if (abs) try { await revealItemInDir(abs); } catch (e) { toast(String(e)); }
  }
}
function fsAfter(fromViewer: boolean) {
  if (fromViewer) { stack.pop(); show(cur(), false); } else void fsLoad();
}

async function fsNewNote() {
  const n = await askName("New note", "Untitled.txt", "Create");
  if (!n) return;
  const name = extOf(n) ? n : n + ".txt";
  if (taken(name)) return toast("That name is already taken");
  if (await writeBytes(joinPath(fsDir, name), new Uint8Array(0))) { fsFile = joinPath(fsDir, name); show("viewer"); }
}
async function fsNewFolder() {
  const n = await askName("New folder", "Untitled folder", "Create");
  if (!n) return;
  if (taken(n)) return toast("That name is already taken");
  if (await run("fs_mkdir", { rel: joinPath(fsDir, n) })) void fsLoad();
}
function fsImport() {
  const inp = document.createElement("input");
  inp.type = "file";
  inp.multiple = true;
  inp.onchange = async () => {
    let n = 0;
    for (const f of Array.from(inp.files ?? [])) {
      if (f.size > MAX_IMPORT) { toast(`${f.name} is over 50 MB`); continue; }
      if (await writeBytes(joinPath(fsDir, uniqueName(f.name)), new Uint8Array(await f.arrayBuffer()))) { n++; await fsLoad(); }
    }
    if (n) toast(`Imported ${n} file${n > 1 ? "s" : ""}`);
  };
  inp.click();
}

async function openViewer() {
  const box = document.getElementById("fsbody");
  if (!box) return;
  if (fsUrl) { URL.revokeObjectURL(fsUrl); fsUrl = ""; }
  const name = baseOf(fsFile);
  const ext = extOf(name);
  const meta = await call<[string, boolean, number, number][]>("fs_list", { rel: parentOf(fsFile) });
  const size = meta?.find((m) => m[0] === name)?.[2] ?? 0;
  const info = (msg: string) => { box.innerHTML = `<p class="empty">${esc(msg)}</p>`; };
  if (IMG_EXT.has(ext)) {
    const buf = await call<ArrayBuffer>("fs_read", { rel: fsFile });
    if (!buf) return info("Couldn't open this image.");
    fsUrl = URL.createObjectURL(new Blob([buf], { type: ext === "svg" ? "image/svg+xml" : `image/${ext === "jpg" ? "jpeg" : ext}` }));
    box.innerHTML = `<img class="fsimg" alt="${esc(name)}" src="${fsUrl}" />`;
  } else if (TEXT_EXT.has(ext) || !ext) {
    if (size > MAX_TEXT) return info("This file is too large to edit here. Use “Show on PC”.");
    const buf = await call<ArrayBuffer>("fs_read", { rel: fsFile });
    if (!buf) return info("Couldn't open this file.");
    box.innerHTML = `<textarea class="fstext" id="fstext" spellcheck="false"></textarea>`;
    const ta = $<HTMLTextAreaElement>("#fstext");
    ta.value = new TextDecoder().decode(buf);
    ta.focus();
  } else info(`No preview for .${ext} files (${bytes(size)}). Use “Show on PC” to open it.`);
}
async function fsSave() {
  const ta = document.getElementById("fstext") as HTMLTextAreaElement | null;
  if (ta && (await writeBytes(fsFile, new TextEncoder().encode(ta.value)))) toast("Saved");
}

view.addEventListener("click", async (e) => {
  const el = (e.target as HTMLElement).closest<HTMLElement>("[data-fs]");
  if (!el) return;
  const a = el.dataset.fs;
  const name = el.dataset.name ?? "";
  if (a === "open") {
    const ent = fsEnts.find((x) => x.name === name);
    if (!ent) return;
    if (ent.dir) { fsDir = joinPath(fsDir, name); void fsLoad(); }
    else { fsFile = joinPath(fsDir, name); show("viewer"); }
  } else if (a === "cd") { fsDir = el.dataset.path ?? ""; void fsLoad(); }
  else if (a === "menu") await fsMenu(joinPath(fsDir, name), !!fsEnts.find((x) => x.name === name)?.dir);
  else if (a === "vmenu") await fsMenu(fsFile, false, true);
  else if (a === "newdir") await fsNewFolder();
  else if (a === "newnote") await fsNewNote();
  else if (a === "import") fsImport();
  else if (a === "save") await fsSave();
  else if (a === "here") {
    const abs = await call<string>("fs_abs", { rel: fsDir });
    if (abs) try { await revealItemInDir(abs); } catch (err) { toast(String(err)); }
  }
});

// ---- Apps: third-party web apps in Documents/FakePhone/Apps/<id>, run in a sandbox ----
// See docs/APPS.md. Each app is an iframe with no network and no access to the phone;
// it can only call the `phone` API below, and each call is permission-checked here.
type Manifest = { id: string; name: string; version?: string; entry: string; icon?: string; permissions: string[]; devUrl?: string };
type Installed = Manifest & { img?: string };
type P = Record<string, unknown>;

const PERMS: Record<string, string> = {
  toast: "show messages on screen",
  storage: "store files in its own private folder",
  identity: "see your phone number and theme",
  "messages.send": "send messages from your number",
};
let installed: Installed[] = [];
let running: { m: Manifest; frame: HTMLIFrameElement; hello: boolean; sig: string } | null = null;
let grants = load<Record<string, Record<string, boolean>>>("grants", {});
const warned = new Set<string>();

const okRel = (s: string) => s.length <= 200 && s.split("/").every(validName);
const readBuf = (rel: string) => invoke<ArrayBuffer>("fs_read", { rel });
const readText = async (rel: string) => new TextDecoder().decode(await readBuf(rel));
const MIME: Record<string, string> = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", svg: "image/svg+xml", woff2: "font/woff2", woff: "font/woff", ttf: "font/ttf" };
function b64(buf: ArrayBuffer) {
  const u = new Uint8Array(buf);
  let s = "";
  for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode(...u.subarray(i, i + 0x8000));
  return btoa(s);
}
const dataUrl = async (rel: string) => `data:${MIME[extOf(rel)] ?? "application/octet-stream"};base64,${b64(await readBuf(rel))}`;

function parseManifest(folder: string, txt: string): Manifest | string {
  let j: Record<string, unknown>;
  try { j = JSON.parse(txt); } catch { return "manifest.json isn't valid JSON"; }
  if (!j || typeof j !== "object") return "manifest.json must be an object";
  if (typeof j.id !== "string" || !/^[a-z0-9][a-z0-9-]{0,39}$/.test(j.id)) return "id must be lowercase letters, digits and dashes";
  if (j.id !== folder) return `id must match the folder name “${folder}”`;
  if (typeof j.name !== "string" || !j.name.trim() || j.name.length > 30) return "name must be 1–30 characters";
  const entry = j.entry === undefined ? "index.html" : j.entry;
  if (typeof entry !== "string" || !okRel(entry)) return "entry isn't a valid path";
  if (j.icon !== undefined && (typeof j.icon !== "string" || !okRel(j.icon) || !IMG_EXT.has(extOf(j.icon)))) return "icon must be a png, jpg, gif, webp or svg in the app folder";
  // Optional dev server for Developer mode: only plain localhost, and never the phone's own origin.
  let devUrl: string | undefined;
  if (j.devUrl !== undefined) {
    try {
      const u = new URL(String(j.devUrl));
      if (u.protocol !== "http:" || !["localhost", "127.0.0.1"].includes(u.hostname) || !u.port || u.origin === location.origin) throw new Error("bad");
      devUrl = u.href;
    } catch { return "devUrl must be http://localhost:<port> and can't be the phone's own address"; }
  }
  const permissions = j.permissions === undefined ? [] : j.permissions;
  if (!Array.isArray(permissions) || permissions.some((p) => typeof p !== "string" || !(p in PERMS))) return `permissions can only be: ${Object.keys(PERMS).join(", ")}`;
  return { id: j.id, name: j.name.trim(), version: typeof j.version === "string" ? j.version : undefined, entry, icon: j.icon as string | undefined, permissions: permissions as string[], devUrl };
}

const allApps = (): App[] => apps.concat(installed.map((m) => ({ id: "app:" + m.id, name: m.name, icon: "apps", img: m.img })));

function warnOnce(folder: string, e: unknown) {
  const msg = e instanceof Error ? e.message : String(e);
  if (warned.has(folder + msg)) return;
  warned.add(folder + msg);
  console.warn(`App “${folder}”: ${msg}`);
  toast(`App “${folder}”: ${msg}`);
}

let loadingApps = false;
async function refreshApps() {
  if (!inTauri || loadingApps) return;
  loadingApps = true;
  try {
    // First time ever: create the Apps folder and drop in the sample app.
    if (await invoke("fs_mkdir", { rel: "Apps" }).then(() => true, () => false)) await seedApps();
    const list = await invoke<[string, boolean, number, number][]>("fs_list", { rel: "Apps" });
    const next: Installed[] = [];
    for (const [folder, isDir] of list) {
      if (!isDir) continue;
      try {
        const m = parseManifest(folder, await readText(`Apps/${folder}/manifest.json`));
        if (typeof m === "string") throw new Error(m);
        const app: Installed = { ...m };
        if (m.icon) {
          try { app.img = URL.createObjectURL(new Blob([await readBuf(`Apps/${folder}/${m.icon}`)], { type: MIME[extOf(m.icon)] })); } catch { /* fall back to the default icon */ }
        }
        next.push(app);
      } catch (e) { warnOnce(folder, e); }
    }
    installed.forEach((i) => i.img && URL.revokeObjectURL(i.img));
    installed = next.sort((a, b) => a.name.localeCompare(b.name));
    if (cur() === "drawer") drawGrid();
  } catch { /* storage unavailable */ } finally { loadingApps = false; }
}

const README = `Put app folders here. Each needs a manifest.json.
The "hello" folder is a working example: copy it, rename the folder, and edit it.
Full guide: docs/APPS.md in the fake-phone project.
`;
async function seedApps() {
  const files: Record<string, string> = {
    "Apps/README.txt": README,
    "Apps/hello/manifest.json": helloManifest,
    "Apps/hello/index.html": helloHtml,
    "Apps/hello/app.js": helloJs,
    "Apps/hello/style.css": helloCss,
    "Apps/hello/icon.svg": helloIcon,
  };
  for (const [rel, text] of Object.entries(files)) await writeBytes(rel, new TextEncoder().encode(text));
}

// Resolve an href inside the app folder, or null for anything external / outside it.
function resolveIn(dir: string, href: string): string | null {
  if (/^([a-z][a-z0-9+.-]*:|\/|#)/i.test(href)) return null;
  const out = dir ? dir.split("/") : [];
  try {
    for (const seg of href.split(/[?#]/)[0].split("/")) {
      if (seg === "" || seg === ".") continue;
      if (seg === "..") { if (!out.length) return null; out.pop(); } else out.push(decodeURIComponent(seg));
    }
  } catch { return null; }
  return out.length && out.every(validName) ? out.join("/") : null;
}
const dirOf = (p: string) => p.split("/").slice(0, -1).join("/");

async function inlineCss(base: string, rel: string, css: string) {
  const re = /url\(\s*(['"]?)([^'")]+)\1\s*\)/g;
  let out = "";
  let last = 0;
  for (const m of css.matchAll(re)) {
    out += css.slice(last, m.index);
    last = m.index! + m[0].length;
    const p = resolveIn(dirOf(rel), m[2]);
    let url = m[2];
    if (p) try { url = await dataUrl(`${base}/${p}`); } catch { /* leave as is; it will simply not load */ }
    out += `url("${url}")`;
  }
  return out + css.slice(last);
}

// A literal "</script" inside inlined code would end the <script> tag early.
const inlineJs = (js: string) => js.replace(/<\/script/gi, "<\\/script");

async function buildDoc(m: Manifest): Promise<string> {
  const base = `Apps/${m.id}`;
  const doc = new DOMParser().parseFromString(await readText(`${base}/${m.entry}`), "text/html");
  const dir = dirOf(m.entry);
  for (const l of Array.from(doc.querySelectorAll<HTMLLinkElement>('link[rel~="stylesheet"][href]'))) {
    const p = resolveIn(dir, l.getAttribute("href")!);
    if (!p) continue;
    const st = doc.createElement("style");
    st.textContent = await inlineCss(base, p, await readText(`${base}/${p}`));
    l.replaceWith(st);
  }
  for (const s of Array.from(doc.querySelectorAll<HTMLScriptElement>("script[src]"))) {
    const p = resolveIn(dir, s.getAttribute("src")!);
    if (!p) continue;
    s.textContent = inlineJs(await readText(`${base}/${p}`));
    s.removeAttribute("src");
  }
  for (const i of Array.from(doc.querySelectorAll<HTMLImageElement>("img[src]"))) {
    const p = resolveIn(dir, i.getAttribute("src")!);
    if (p) try { i.setAttribute("src", await dataUrl(`${base}/${p}`)); } catch { /* broken image */ }
  }
  // No network at all: everything the app needs has to be inlined above.
  const csp = doc.createElement("meta");
  csp.httpEquiv = "Content-Security-Policy";
  csp.content = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; media-src data:";
  const sdk = doc.createElement("script");
  sdk.textContent = inlineJs(sdkSrc);
  doc.head.prepend(sdk);
  doc.head.prepend(csp);
  return "<!doctype html>" + doc.documentElement.outerHTML;
}

// ---- Developer mode: console, auto-reload, dev-server apps ----
const devLogs: { lvl: string; text: string }[] = [];
let devErrs = 0;
let devOpen = false;
const devOn = () => !!toggles["Developer mode"];
function devLog(lvl: string, text: string) {
  devLogs.push({ lvl, text: text.slice(0, 2000) });
  if (devLogs.length > 300) devLogs.shift();
  if (lvl === "error" && !devOpen) devErrs++;
  drawDev();
}
function drawDev() {
  const panel = document.getElementById("devlog");
  const badge = document.getElementById("devcount");
  const lines = document.getElementById("devlines");
  if (panel) panel.hidden = !devOpen;
  if (badge) { badge.hidden = !devErrs || devOpen; badge.textContent = String(devErrs); }
  if (lines && devOpen) {
    lines.innerHTML = devLogs.map((l) => `<div class="ll ${l.lvl}">${esc(l.text)}</div>`).join("");
    lines.scrollTop = lines.scrollHeight;
  }
}
// Signature of every file in an app folder, to notice edits.
async function appSig(rel: string, depth = 0): Promise<string> {
  const list = await invoke<[string, boolean, number, number][]>("fs_list", { rel }).catch(() => [] as [string, boolean, number, number][]);
  let s = "";
  for (const [n, d, size, ts] of list) s += d ? (depth < 4 ? `${n}/{${await appSig(`${rel}/${n}`, depth + 1)}}` : "") : `${n}:${size}:${ts};`;
  return s;
}
let watching = false;
setInterval(async () => {
  const r = running;
  if (!r || watching || !devOn() || !inTauri || r.m.devUrl || !r.sig) return;
  watching = true;
  try {
    if ((await appSig(`Apps/${r.m.id}`)) !== r.sig && running === r) {
      devLog("info", "Files changed, reloading");
      await refreshApps();
      if (running === r) await launchApp(r.m.id);
    }
  } finally { watching = false; }
}, 1000);

async function launchApp(id: string) {
  const frame = document.getElementById("appframe") as HTMLIFrameElement | null;
  const m = installed.find((x) => x.id === id);
  if (!frame || !m) return;
  const dev = devOn();
  try {
    frame.removeAttribute("srcdoc");
    if (dev && m.devUrl) {
      // Loaded from your own dev server (its own origin, so it can't touch the phone).
      // This isn't network-sandboxed: it's for development only.
      const r = { m, frame, hello: false, sig: "" };
      frame.setAttribute("sandbox", "allow-scripts allow-same-origin");
      running = r;
      frame.src = m.devUrl;
      devLog("info", `Loading ${m.devUrl}`);
      setTimeout(() => {
        if (running === r && !r.hello) devLog("error", 'No phone SDK found. Add <script src="phone-sdk.js"></script> to your page (copy src/sdk/phone-sdk.js).');
      }, 4000);
    } else {
      frame.setAttribute("sandbox", "allow-scripts");
      const sig = dev ? await appSig(`Apps/${id}`) : "";
      let html: string;
      try { html = await buildDoc(m); } catch (e) {
        if (m.devUrl && !dev) throw new Error("This app loads from a dev server. Turn on Developer mode in Settings.");
        throw e;
      }
      if (cur() !== "app:" + id) return; // user already left
      running = { m, frame, hello: false, sig };
      frame.srcdoc = html;
      if (dev) devLog("info", `Started ${m.name}`);
    }
  } catch (e) {
    $("#view").innerHTML = `<div class="page"><div class="title">${esc(m.name)}</div><p class="note">Couldn't start this app: ${esc(e instanceof Error ? e.message : String(e))}</p></div>`;
  }
}

const pendingAsk = new Map<string, Promise<boolean>>();
async function allowed(a: Manifest, perm: string): Promise<boolean> {
  if (!a.permissions.includes(perm)) throw new Error(`"${perm}" isn't listed in permissions in manifest.json`);
  const g = grants[a.id]?.[perm];
  if (g !== undefined) return g;
  const key = `${a.id}:${perm}`;
  let p = pendingAsk.get(key);
  if (!p) {
    p = popup(`<div class="title sm">${esc(a.name)}</div><p class="note">This app wants to ${esc(PERMS[perm])}.</p>
      <div class="stack"><button class="btn wide" data-d="allow">Allow</button><button class="btn wide ghost" data-d="deny">Deny</button></div>`).then((r) => {
      if (r.id !== "allow" && r.id !== "deny") return false; // dismissed: deny this time, ask again next time
      (grants[a.id] ??= {})[perm] = r.id === "allow";
      save("grants", grants);
      return r.id === "allow";
    }).finally(() => pendingAsk.delete(key));
    pendingAsk.set(key, p);
  }
  return p;
}

const str = (v: unknown, what: string) => {
  if (typeof v !== "string") throw new Error(`${what} must be a string`);
  return v;
};
function dataPath(a: Manifest, v: unknown, allowEmpty = false) {
  const s = v === undefined || v === "" ? "" : str(v, "path");
  if (!s && !allowEmpty) throw new Error("path is required");
  if (s && !okRel(s)) throw new Error("Invalid path");
  return `AppData/${a.id}${s ? "/" + s : ""}`;
}

const API = new Map<string, { perm: string; run: (a: Manifest, p: P) => Promise<unknown> }>([
  ["sdk.hello", { perm: "", run: async () => { if (running) running.hello = true; return null; } }],
  ["toast", { perm: "toast", run: async (a, p) => { toast(`${a.name}: ${str(p.text, "text").slice(0, 80)}`); return null; } }],
  ["fs.read", { perm: "storage", run: async (a, p) => {
    const buf = await readBuf(dataPath(a, p.path));
    if (buf.byteLength > 5 * 1024 * 1024) throw new Error("File is too large to read as text");
    return new TextDecoder().decode(buf);
  } }],
  ["fs.write", { perm: "storage", run: async (a, p) => {
    const data = str(p.data, "data");
    if (data.length > 2 * 1024 * 1024) throw new Error("Files are limited to 2 MB");
    await invoke("fs_write", new TextEncoder().encode(data), { headers: { "x-path": encodeURIComponent(dataPath(a, p.path)) } });
    return null;
  } }],
  ["fs.list", { perm: "storage", run: async (a, p) => {
    const rel = dataPath(a, p.path, true);
    await invoke("fs_mkdir", { rel }).catch(() => undefined); // make sure it exists (errors if it already does)
    const r = await invoke<[string, boolean, number, number][]>("fs_list", { rel });
    return r.map(([name, dir, size, modified]) => ({ name, dir, size, modified }));
  } }],
  ["fs.remove", { perm: "storage", run: async (a, p) => { await invoke("fs_delete", { rel: dataPath(a, p.path) }); return null; } }],
  ["identity.number", { perm: "identity", run: async () => myNum }],
  ["identity.theme", { perm: "identity", run: async () => (toggles["Dark mode"] ? "dark" : "light") }],
  ["messages.send", { perm: "messages.send", run: async (_a, p) => {
    const to = str(p.to, "to");
    const text = str(p.text, "text").trim();
    if (!NUM.test(to)) throw new Error("to must be a 10-digit number");
    if (!text || text.length > 1000) throw new Error("text must be 1–1000 characters");
    if (!(await sendMsg(to, text))) throw new Error("Message failed to send");
    return null;
  } }],
]);

async function serve(r: NonNullable<typeof running>, d: { id: number; method: string; params?: unknown }) {
  const reply = (ok: boolean, v: unknown) =>
    r.frame.contentWindow?.postMessage(ok ? { fp: 1, id: d.id, ok, result: v } : { fp: 1, id: d.id, ok, error: v }, "*");
  const api = API.get(d.method);
  if (!api) return reply(false, `Unknown method “${d.method}”`);
  try {
    if (api.perm && !(await allowed(r.m, api.perm))) return reply(false, `Permission “${api.perm}” was denied`);
    const params = d.params && typeof d.params === "object" ? (d.params as P) : {};
    reply(true, await api.run(r.m, params));
  } catch (e) { reply(false, e instanceof Error ? e.message : String(e)); }
}
view.addEventListener("click", (e) => {
  const el = (e.target as HTMLElement).closest<HTMLElement>("[data-dev]");
  if (!el) return;
  const a = el.dataset.dev;
  if (a === "console") { devOpen = !devOpen; if (devOpen) devErrs = 0; drawDev(); }
  else if (a === "clear") { devLogs.length = 0; devErrs = 0; drawDev(); }
  else if (a === "reload" && running) {
    const id = running.m.id;
    devLog("info", "Reloading");
    void refreshApps().then(() => launchApp(id));
  }
});
window.addEventListener("message", (e) => {
  const d = e.data;
  if (!running || e.source !== running.frame.contentWindow || !d || d.fp !== 1) return;
  if (typeof d.log === "string") {
    if (devOn()) devLog(["log", "info", "warn", "error"].includes(d.log) ? d.log : "log", String(d.text ?? ""));
    return;
  }
  if (typeof d.id !== "number" || typeof d.method !== "string") return;
  void serve(running, d);
});

// ---- UI ----
const paths: Record<string, string> = {
  folder: '<path d="M3 6a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
  file: '<path d="M6 2h8l5 5v13a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2zm7 1.5V8h4.5z"/>',
  chat: '<path d="M4 3h16a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H8l-5 4V5a2 2 0 0 1 1-2z"/>',
  phone: '<path d="M6.6 10.8a15 15 0 0 0 6.6 6.6l2.2-2.2a1 1 0 0 1 1-.25c1.1.37 2.3.57 3.6.57a1 1 0 0 1 1 1V20a1 1 0 0 1-1 1A17 17 0 0 1 3 4a1 1 0 0 1 1-1h3.5a1 1 0 0 1 1 1c0 1.25.2 2.45.57 3.57a1 1 0 0 1-.25 1z"/>',
  contacts: '<circle cx="12" cy="8" r="4"/><path d="M4 21c0-4 3.6-6 8-6s8 2 8 6z"/>',
  settings: '<g class="s"><circle cx="12" cy="12" r="3"/><circle cx="12" cy="12" r="8" stroke-width="3" stroke-dasharray="3.1 3.1"/></g>',
  apps: "<g>" + [5, 12, 19].flatMap((x) => [5, 12, 19].map((y) => `<circle cx="${x}" cy="${y}" r="1.8"/>`)).join("") + "</g>",
  games: '<rect x="2" y="7" width="20" height="11" rx="5.5"/><circle cx="8" cy="12.5" r="1.4" fill="#fff"/><circle cx="16" cy="12.5" r="1.4" fill="#fff"/>',
  camera: '<path d="M4 7h3l2-3h6l2 3h3a1 1 0 0 1 1 1v11a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V8a1 1 0 0 1 1-1z"/><circle cx="12" cy="13" r="3.4" fill="#fff"/>',
  notes: '<path d="M5 3h14a1 1 0 0 1 1 1v16a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1zm3 5v2h8V8zm0 4v2h8v-2z"/>',
  search: '<g class="s"><circle cx="11" cy="11" r="6"/><path d="M16 16l4 4"/></g>',
  cloud: '<g class="s"><path d="M7 18a4 4 0 0 1-.5-8 5.5 5.5 0 0 1 10.6 1A3.5 3.5 0 0 1 17 18z"/><path d="M4 4l16 16"/></g>',
};
const icon = (n: string) => `<svg class="i" viewBox="0 0 24 24">${paths[n]}</svg>`;

type App = { id: string; name: string; icon: string; img?: string };
const apps: App[] = [
  { id: "messages", name: "Messages", icon: "chat" },
  { id: "settings", name: "Settings", icon: "settings" },
  { id: "contacts", name: "Contacts", icon: "contacts" },
  { id: "phone", name: "Phone", icon: "phone" },
  { id: "camera", name: "Camera", icon: "camera" },
  { id: "notes", name: "Notes", icon: "notes" },
  { id: "games", name: "Games", icon: "games" },
  { id: "files", name: "Files", icon: "folder" },
];
const byId = (id: string) => allApps().find((a) => a.id === id)!;
const tile = (a: App) => `<button class="app" data-open="${a.id}"><span class="tile">${a.img ? `<img class="appimg" alt="" src="${a.img}" />` : icon(a.icon)}</span>${esc(a.name)}</button>`;

const contacts = ["Alex Rivera", "Bree Walker", "Dad", "Jordan Lee", "Mum", "Sam Patel"];
const toggles: Record<string, boolean> = { "Wi-Fi": true, Bluetooth: false, "Airplane mode": false, "Dark mode": false, "Developer mode": load<boolean>("dev", false) };

let stack: string[] = ["home"];
const cur = () => stack[stack.length - 1];

function toast(msg: string) {
  const t = $("#toast");
  t.textContent = msg;
  t.classList.add("show");
  setTimeout(() => t.classList.remove("show"), 1800);
}

function page(id: string): string {
  if (id.startsWith("app:"))
    return `<div class="page app"><iframe id="appframe" sandbox="allow-scripts" title="${esc(byId(id)?.name ?? "App")}"></iframe>${
      devOn()
        ? `<div class="devbar"><button class="chip" data-dev="reload" title="Reload app">↻</button><button class="chip" data-dev="console">Console <b class="badge static" id="devcount" hidden></b></button></div>
           <div class="devlog" id="devlog" hidden><div class="devhead"><b>Console</b><button data-dev="clear">Clear</button><button data-dev="console">Close</button></div><div class="devlines" id="devlines"></div></div>`
        : ""
    }</div>`;
  if (id.startsWith("thread:"))
    return `<div class="page"><div class="title">${fmt(id.slice(7))}</div><div class="bubbles" id="bubbles"></div>
      <div class="compose"><input class="field" id="msg" placeholder="Text message" maxlength="1000" autocomplete="off" />
      <button class="btn" data-act="send">Send</button></div></div>`;
  switch (id) {
    case "files":
      return `<div class="page"><div class="head"><div class="title">Files</div><button class="btn sm ghost" data-fs="here">Show on PC</button></div>
        <div class="crumbs" id="fscrumbs"></div>
        <div class="fsbar"><button class="btn sm" data-fs="newdir">+ Folder</button><button class="btn sm" data-fs="newnote">+ Note</button><button class="btn sm ghost" data-fs="import">Import</button></div>
        <div class="fslist" id="fslist"></div></div>`;
    case "viewer":
      return `<div class="page"><div class="head"><div class="title fname">${esc(baseOf(fsFile))}</div>
        <span class="fsact"><button class="btn sm" data-fs="save">Save</button><button class="btn sm ghost" data-fs="vmenu" aria-label="More">⋯</button></span></div>
        <div class="fsbody" id="fsbody"></div></div>`;
    case "setup":
      return `<div class="page"><div class="title">Setup needed</div>
        <p class="note">Add VITE_NEON_AUTH_URL and VITE_NEON_DATA_API_URL to a .env file, then restart the app.</p></div>`;
    case "auth":
      return `<div class="page"><div class="title">Sign in</div>
        <p class="note">One-time sign-in. Your phone number is created for you.</p>
        <input class="field" id="email" type="email" placeholder="Email" autocomplete="username" />
        <input class="field" id="pw" type="password" placeholder="Password (8+ characters)" autocomplete="current-password" />
        <div class="stack"><button class="btn wide" data-act="signin">Sign in</button>
        <button class="btn wide ghost" data-act="signup">Create account</button></div></div>`;
    case "home":
      return `<div class="page">
        <div class="widget"><span class="clock" id="clock">00:00</span><svg viewBox="0 0 24 24">${paths.cloud}</svg>
          <span class="date" id="date"></span><span class="temp">30°C</span></div>
        <button class="search" data-open="drawer">${icon("search").replace('class="i"', 'class="i s"')}Search apps</button>
        <div class="spacer"></div>
        <button class="games" data-open="games" aria-label="Games">${icon("games")}</button>
        <div class="dock">${["messages", "settings"].map((i) => tile(byId(i))).join("")}
          <button class="app" data-open="drawer"><span class="tile">${icon("apps")}</span>Apps</button>
          ${["contacts", "phone"].map((i) => tile(byId(i))).join("")}</div></div>`;
    case "drawer":
      return `<div class="page"><input class="field" id="q" placeholder="Search apps" autocomplete="off" />
        <div class="grid" id="grid">${allApps().map(tile).join("")}</div></div>`;
    case "messages": {
      const peers = Object.keys(threads).sort((a, b) => last(b).ts - last(a).ts);
      return `<div class="page"><div class="head"><div class="title">Messages</div><button class="btn sm" data-act="new">New</button></div>
        <span class="mine">Your number: ${fmt(myNum)}</span>
        ${peers.length
          ? `<div class="card">${peers.map((p) => `<button class="row" data-open="thread:${p}"><span class="avatar">#</span>
              <span class="grow">${fmt(p)}<small>${last(p).out ? "You: " : ""}${esc(last(p).text)}</small></span>
              ${unread[p] ? `<b class="badge static">${unread[p]}</b>` : ""}</button>`).join("")}</div>`
          : '<p class="empty">No conversations yet.<br />Tap New and enter a number.</p>'}</div>`;
    }
    case "new":
      return `<div class="page"><div class="title">New message</div>
        <input class="field" id="num" inputmode="numeric" placeholder="Enter a phone number" autocomplete="off" />
        <button class="btn wide" data-act="start">Start chat</button></div>`;
    case "contacts":
      return `<div class="page"><div class="title">Contacts</div><div class="card">${contacts
        .map((n) => `<button class="row" data-call="${n}"><span class="avatar">${n[0]}</span><span class="grow">${n}</span></button>`)
        .join("")}</div></div>`;
    case "settings":
      return `<div class="page"><div class="title">Settings</div><div class="card">${Object.entries(toggles)
        .map(([k, v]) => `<div class="row"><span class="grow">${k}</span><button class="switch" role="switch" aria-checked="${v}" data-toggle="${k}" aria-label="${k}"></button></div>`)
        .join("")}</div>
        <div class="card"><div class="row"><span class="grow">Your number<small>${fmt(myNum)}</small></span></div>
        <div class="row"><span class="grow">App permissions<small>Forget what apps are allowed</small></span><button class="btn sm ghost" data-act="resetgrants">Reset</button></div>
        <div class="row"><span class="grow">Account<small>${esc(user?.email ?? "")}</small></span><button class="btn sm" data-act="signout">Sign out</button></div></div></div></div>`;
    case "phone":
      return `<div class="page"><div class="dial" id="dial"></div><div class="pad">${[..."123456789*0#"]
        .map((k) => `<button class="key" data-key="${k}">${k}</button>`)
        .join("")}<button class="key" data-key="⌫">⌫</button><button class="key call" data-call="">Call</button><span></span></div></div>`;
    default:
      return `<div class="page"><div class="title">${esc(byId(id)?.name ?? id)}</div><p class="empty">Nothing here yet.</p></div>`;
  }
}

function drawBubbles() {
  const box = document.getElementById("bubbles");
  const c = cur();
  if (!box || !c.startsWith("thread:")) return;
  box.innerHTML = (threads[c.slice(7)] ?? [])
    .map((m) => `<div class="bub ${m.out ? "out" : "in"}">${esc(m.text)}<small>${hm(m.ts)}${m.st === "failed" ? " Not sent" : ""}</small></div>`)
    .join("");
  box.scrollTop = box.scrollHeight;
}

function refreshBadge() {
  const n = Object.values(unread).reduce((a, b) => a + b, 0);
  document.querySelectorAll('[data-open="messages"] .tile').forEach((t) => {
    t.querySelector(".badge")?.remove();
    if (n) t.insertAdjacentHTML("beforeend", `<b class="badge">${n}</b>`);
  });
}

function drawGrid() {
  const g = document.getElementById("grid");
  if (!g) return;
  const s = (document.getElementById("q") as HTMLInputElement | null)?.value.toLowerCase() ?? "";
  g.innerHTML = allApps().filter((a) => a.name.toLowerCase().includes(s)).map(tile).join("");
  refreshBadge();
}

function show(id: string, push = true) {
  if (!client) { id = "setup"; stack = ["setup"]; push = false; }
  else if (!user && id !== "auth") { id = "auth"; stack = ["auth"]; push = false; }
  if (push) stack.push(id);
  if (!id.startsWith("app:")) running = null;
  view.innerHTML = page(id);
  tick();
  if (id === "drawer") {
    const q = $<HTMLInputElement>("#q");
    q.oninput = drawGrid;
    q.focus();
    void refreshApps();
  } else if (id.startsWith("thread:")) {
    delete unread[id.slice(7)];
    save("unread", unread);
    drawBubbles();
    $("#msg").focus();
  } else if (id === "new") $("#num").focus();
  else if (id === "auth") $("#email").focus();
  else if (id === "files") void fsLoad();
  else if (id === "viewer") void openViewer();
  else if (id.startsWith("app:")) { devLogs.length = 0; devErrs = 0; devOpen = false; drawDev(); void launchApp(id.slice(4)); }
  refreshBadge();
}

async function act(a: string) {
  if (a === "new") show("new");
  else if (a === "start") {
    const n = $<HTMLInputElement>("#num").value.replace(/\D/g, "");
    if (!NUM.test(n)) return toast("Enter a 10-digit number");
    if (n === myNum) return toast("That's your own number");
    const r = await client!.rpc("number_exists", { n });
    if (r.error) return toast(r.error.message);
    if (r.data !== true) return toast("That number doesn't exist");
    stack.pop();
    show("thread:" + n);
  } else if (a === "send") {
    const box = $<HTMLInputElement>("#msg");
    const text = box.value.trim();
    if (!text) return;
    if (await sendMsg(cur().slice(7), text)) box.value = "";
    box.focus();
  } else if (a === "signin" || a === "signup") await authenticate(a);
  else if (a === "signout") await signOut();
  else if (a === "resetgrants") { grants = {}; save("grants", grants); toast("App permissions reset"); }
}

function tick() {
  const d = new Date();
  const t = hm(d.getTime());
  $("#status-time").textContent = t;
  const c = document.getElementById("clock");
  if (c) c.textContent = t;
  const dt = document.getElementById("date");
  if (dt) dt.textContent = d.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "2-digit", year: "numeric" }).replace(/^(\w+), (\w+) (\d+), (\d+)$/, "$1, $2 $3 $4");
}

view.addEventListener("click", (e) => {
  const el = (e.target as HTMLElement).closest<HTMLElement>("[data-open],[data-act],[data-toggle],[data-key],[data-call]");
  if (!el) return;
  if (el.dataset.open) show(el.dataset.open);
  else if (el.dataset.act) void act(el.dataset.act);
  else if (el.dataset.toggle) {
    const k = el.dataset.toggle;
    toggles[k] = !toggles[k];
    el.setAttribute("aria-checked", String(toggles[k]));
    if (k === "Dark mode") $("#screen").classList.toggle("dark", toggles[k]);
    if (k === "Developer mode") save("dev", toggles[k]);
  } else if (el.dataset.key) {
    const dial = $("#dial");
    dial.textContent = el.dataset.key === "⌫" ? dial.textContent!.slice(0, -1) : (dial.textContent! + el.dataset.key).slice(0, 15);
  } else if (el.dataset.call !== undefined) toast("Calls aren't supported yet");
});
view.addEventListener("keydown", (e) => {
  if (e.key !== "Enter") return;
  const id = (e.target as HTMLElement).id;
  if (id === "msg") void act("send");
  else if (id === "num") void act("start");
  else if (id === "pw") void act("signin");
});

document.querySelector(".nav")!.addEventListener("click", (e) => {
  const n = (e.target as HTMLElement).closest<HTMLElement>("[data-nav]")?.dataset.nav;
  if (n === "home") { stack = ["home"]; show("home", false); }
  else if (n === "recents") show("drawer");
  else if (n === "back" && cur() === "files" && fsDir) { fsDir = parentOf(fsDir); void fsLoad(); }
  else if (n === "back" && stack.length > 1) { stack.pop(); show(cur(), false); }
});

$("#power").addEventListener("click", () => getCurrentWindow().close());

window.addEventListener("DOMContentLoaded", async () => {
  show("home", false);
  setInterval(tick, 1000);
  setInterval(() => void poll(), 3000);
  if (inTauri) void refreshApps();
  if (!client) return;
  const s = await client.auth.getSession();
  if (s.data?.session && s.data.user) await signedIn({ id: s.data.user.id, email: s.data.user.email });
});
