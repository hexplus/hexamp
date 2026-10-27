// Album covers: fetched once as small JPEGs, kept in cache:/art (so the next
// launch has them without the network), and shown with <img>. A cover is a
// signal: null until the file is there.
//
// The file name carries the server's image tag, so a cover changed on the
// server is fetched again. The covers keep to ART_BUDGET of the cache (the
// oldest go first): the rest is for songs in download mode.

import { fs } from "@pspx/native";
import { signal, type Signal } from "@pspx/ui";
import { authHeaders, imageUrl, type Item } from "./jellyfin";

const DIR = "cache:/art";
const ART_BUDGET = 6 * 1024 * 1024;
const TRIM_EVERY = 512 * 1024; // bytes written between two looks at the folder's size
const known = new Map<string, Signal<string | null>>();
const queue: (() => Promise<void>)[] = [];
let running = 0;
let dirReady: Promise<unknown> | null = null;
let written = ART_BUDGET; // a look at the folder's size once, early in the run
let trimming: Promise<void> | null = null;

function pump(): void {
    while (running < 2 && queue.length) {
        const job = queue.shift()!;
        running++;
        job().catch(() => {}).finally(() => {
            running--;
            pump();
        });
    }
}

function isPicture(b: Uint8Array): boolean {
    return (b[0] === 0xFF && b[1] === 0xD8) || (b[0] === 0x89 && b[1] === 0x50); // JPEG or PNG
}

/** The oldest covers go until the folder is three quarters of its budget
 * (and files named the old way, without the tag, go at once). */
async function trim(): Promise<void> {
    const files: { name: string; size: number; mtime: number }[] = [];
    for (const name of await fs.list(DIR).catch(() => [] as string[])) {
        if (!/^[^_]+_[^_]*_\d+\.jpg$/.test(name)) {
            await fs.remove(`${DIR}/${name}`).catch(() => {});
            continue;
        }
        const st = await fs.stat(`${DIR}/${name}`).catch(() => null);
        if (st?.isFile) files.push({ name, size: st.size, mtime: st.mtime });
    }
    let total = files.reduce((n, f) => n + f.size, 0);
    if (total <= ART_BUDGET) return;
    files.sort((a, b) => a.mtime - b.mtime || (a.name < b.name ? -1 : 1));
    for (const f of files) {
        if (total <= ART_BUDGET * 0.75) break;
        await fs.remove(`${DIR}/${f.name}`).catch(() => {});
        known.delete(f.name.replace(/\.jpg$/, "")); // fetched again if it is wanted
        total -= f.size;
    }
}

function trimSoon(): Promise<void> {
    written = 0;
    trimming ??= trim().finally(() => { trimming = null; });
    return trimming;
}

/** The cover of `item` (or of its album) at `size` pixels: a path once it is on the card. */
export function cover(item: Item, size: number): Signal<string | null> {
    const url = imageUrl(item, size);
    const own = item.ImageTags?.Primary;
    const id = own ? item.Id : item.AlbumId ?? item.Id;
    const tag = (own ?? item.AlbumPrimaryImageTag ?? "").slice(0, 8);
    const key = `${id}_${tag}_${size}`;
    let s = known.get(key);
    if (s) return s;
    s = signal<string | null>(null);
    known.set(key, s);
    if (!url) return s;
    const path = `${DIR}/${key}.jpg`;
    const sig = s;
    const forget = () => { if (known.get(key) === sig) known.delete(key); }; // the next cover() tries again
    queue.push(async () => {
        dirReady ??= fs.mkdir(DIR).catch(() => {});
        await dirReady;
        if (written >= TRIM_EVERY) void trimSoon(); // alongside: the covers keep coming
        if (await fs.exists(path)) return sig.set(path);
        try {
            const res = await fetch(url, { headers: authHeaders(), timeoutMs: 15000, maxBytes: 512 * 1024 });
            if (!res.ok) return forget();
            const bytes = new Uint8Array(await res.arrayBuffer());
            if (!isPicture(bytes)) return; // a format PSPX cannot show (an old server ignoring format=Jpg): not asked again
            try {
                await fs.writeBytes(path, bytes);
            } catch (e) {
                if ((e as { code?: string }).code !== "ENOSPC") throw e;
                await trimSoon(); // the cache is full: room, then once more
                await fs.writeBytes(path, bytes);
            }
            written += bytes.length;
            sig.set(path);
        } catch {
            forget(); // offline, or the card: not for the rest of the run
        }
    });
    pump();
    return s;
}

/** Deletes every cached cover. */
export async function clearCovers(): Promise<void> {
    known.clear();
    for (const name of await fs.list(DIR).catch(() => [] as string[])) await fs.remove(`${DIR}/${name}`).catch(() => {});
}
