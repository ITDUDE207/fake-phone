// Packing and unpacking of App Store bundles. Pure functions, no phone or Tauri code,
// so they can be tested on their own. Everything that arrives from the store is untrusted:
// `unpack` is the gate every downloaded app goes through before a single byte is written.

export const MAX_BYTES = 1_000_000; // total size of an app's files
export const MAX_FILES = 60;
export const MAX_JSON = 1_500_000; // size of the packed text (also enforced by the database)
export const ALLOWED_EXT = new Set([
  "html", "js", "css", "json", "txt", "md", "svg", "png", "jpg", "jpeg", "gif", "webp", "woff", "woff2", "ttf",
]);

const BAD = /[\\/:*?"<>|\0\u0001-\u001f]/;
const DEVICE = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\.|$)/i;
export const okName = (n: string) =>
  !!n && n.length <= 100 && n !== "." && n !== ".." && !n.startsWith(".") && !/[. ]$/.test(n) && !BAD.test(n) && !DEVICE.test(n);
export const okPath = (p: string) => p.length <= 200 && p.split("/").every(okName);
export const extOf = (p: string) => (p.includes(".") ? p.split(".").pop()!.toLowerCase() : "");

export function toB64(u: Uint8Array): string {
  let s = "";
  for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode(...u.subarray(i, i + 0x8000));
  return btoa(s);
}
export function fromB64(s: string): Uint8Array {
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(s) || s.length % 4 !== 0) throw new Error("Corrupt file data");
  const bin = atob(s);
  const u = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
  return u;
}

export async function sha256Hex(text: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(d), (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Problems that would stop a local app folder from being published (empty = fine). */
export function publishProblems(files: { path: string; size: number }[]): string[] {
  const out: string[] = [];
  if (files.length > MAX_FILES) out.push(`Too many files (${files.length}, max ${MAX_FILES})`);
  const total = files.reduce((n, f) => n + f.size, 0);
  if (total > MAX_BYTES) out.push(`Too big (${(total / 1e6).toFixed(1)} MB, max ${MAX_BYTES / 1e6} MB)`);
  for (const f of files) {
    if (!okPath(f.path)) out.push(`Not allowed: ${f.path} (name)`);
    else if (!ALLOWED_EXT.has(extOf(f.path))) out.push(`Not allowed: ${f.path} (file type)`);
  }
  return out.slice(0, 8);
}

export function pack(files: Map<string, Uint8Array>): string {
  const o: Record<string, string> = {};
  for (const [p, d] of files) o[p] = toB64(d);
  return JSON.stringify({ v: 1, files: o });
}

/** Validate a downloaded bundle and return its files. Throws a readable Error if anything is off. */
export function unpack(json: string): Map<string, Uint8Array> {
  if (json.length > MAX_JSON) throw new Error("App is too large");
  let b: unknown;
  try { b = JSON.parse(json); } catch { throw new Error("App data is corrupt"); }
  const f = (b as { v?: unknown; files?: unknown } | null)?.files;
  if ((b as { v?: unknown } | null)?.v !== 1 || !f || typeof f !== "object" || Array.isArray(f)) throw new Error("Unsupported app format");
  const entries = Object.entries(f as Record<string, unknown>);
  if (!entries.length || entries.length > MAX_FILES) throw new Error("App has an invalid number of files");
  const out = new Map<string, Uint8Array>();
  const lower = new Set<string>();
  let total = 0;
  for (const [p, v] of entries) {
    if (!okPath(p)) throw new Error(`App contains a file with a bad name: ${p.slice(0, 40)}`);
    if (!ALLOWED_EXT.has(extOf(p))) throw new Error(`App contains a blocked file type: ${p.slice(0, 40)}`);
    if (lower.has(p.toLowerCase())) throw new Error("App contains duplicate file names");
    lower.add(p.toLowerCase());
    if (typeof v !== "string") throw new Error("Corrupt file data");
    const d = fromB64(v);
    total += d.length;
    if (total > MAX_BYTES) throw new Error("App is too large");
    out.set(p, d);
  }
  if (!out.has("manifest.json")) throw new Error("App has no manifest.json");
  return out;
}
