// Playback: the queue, one Audio at a time, and the two ways to get a song.
//
//   stream    (the default) Jellyfin converts the song to MP3 and the PSP
//             decodes it live from the network. A seek asks the server to
//             start there (startTimeTicks).
//   download  the MP3 goes to cache:/jf as it arrives and plays from there
//             at once; the next song downloads while this one plays, so a
//             weak Wi-Fi has a buffer on the Memory Stick.
//
// When the network drops, a song that runs out waits where it stopped and
// goes on once the network is back (connection.ts says so on screen).

import { app, fs, net, system } from "@pspx/native";
import { batch, computed, signal } from "@pspx/ui";
import * as jf from "./jellyfin";
import type { Item } from "./jellyfin";

export type Mode = "stream" | "download";
export type Repeat = "off" | "all" | "one";

const CACHE = "cache:/jf";

export const settings = {
    mode: signal<Mode>((localStorage.getItem("jf.mode") as Mode | null) ?? "stream"),
    kbps: signal(Number(localStorage.getItem("jf.kbps") ?? 128)),
};

export function setMode(m: Mode): void {
    settings.mode.set(m);
    localStorage.setItem("jf.mode", m);
}

export function setBitrate(kbps: number): void {
    settings.kbps.set(kbps);
    localStorage.setItem("jf.kbps", String(kbps));
}

export const queue = signal<Item[]>([]);
export const index = signal(-1);
export const playing = signal(false);   // the user wants it to play
export const position = signal(0);      // seconds
export const buffering = signal(false);
export const problem = signal<string | null>(null);
export const shuffle = signal(false);
export const repeat = signal<Repeat>("off");
export const current = computed(() => queue()[index()] ?? null);
/** The song at the index now (a computed's peek can be a frame behind). */
const now = (): Item | null => queue.peek()[index.peek()] ?? null;
export const duration = computed(() => {
    const t = current();
    return t ? jf.seconds(t) : 0;
});

let audio: Audio | null = null;
(globalThis as any).__jfAudio = () => audio; // debugging (tests)
let offset = 0;             // stream mode: where the URL started, in seconds
let order: number[] = [];   // the play order (shuffled or not) of queue indexes
let session = "";
let sessionItem = "";       // the song the reports of `session` are about (the index may have moved on)
let lastReport = 0;
let lastTime = -1, stillSince = 0; // the clock: a song stuck at its end
let retries = 0;
let waitingAt = -1;         // the network is down: where the song stopped, to go on from once it is back
let waitTimer = 0;
const WAIT_MAX_MS = 5 * 60 * 1000; // then it gives up (paused), so the PSP can sleep again
const downloads = new Map<string, Download>();
type Download = ReturnType<typeof net.download>;

// ---------------------------------------------------------------- the queue

function shuffled(n: number, first: number): number[] {
    const a = [...Array(n).keys()].filter(i => i !== first);
    for (let i = a.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [a[i], a[j]] = [a[j], a[i]];
    }
    return first >= 0 ? [first, ...a] : a;
}

function rebuildOrder(): void {
    const n = queue.peek().length;
    order = shuffle.peek() ? shuffled(n, index.peek()) : [...Array(n).keys()];
}

/** Plays `items` from `start` (shuffled when `mix`), `at` seconds in. */
export function playList(items: Item[], start = 0, mix = false, at = 0): void {
    batch(() => {
        queue.set(items);
        shuffle.set(mix);
        index.set(mix && start === 0 ? Math.floor(Math.random() * items.length) : start);
    });
    rebuildOrder();
    load(at, true);
}

/** Songs a remote sent (Jellyfin's Play): instead of the queue (from the
 * id at `start`, `at` seconds in), after the song playing, or at the end.
 * With nothing playing, the last two play them. */
export async function playIds(ids: string[], how: "PlayNow" | "PlayNext" | "PlayLast", start = 0, at = 0): Promise<void> {
    const items = await jf.songsById(ids);
    if (!items.length) return;
    if (how === "PlayNow" || !now()) {
        playList(items, Math.max(0, items.findIndex(t => t.Id === ids[start])), false, at);
        return;
    }
    const q = queue.peek(), pos = how === "PlayNext" ? index.peek() + 1 : q.length;
    queue.set([...q.slice(0, pos), ...items, ...q.slice(pos)]);
    rebuildOrder();
}

export function toggleShuffle(): void {
    shuffle.set(!shuffle.peek());
    rebuildOrder();
}

export function cycleRepeat(): void {
    repeat.set(repeat.peek() === "off" ? "all" : repeat.peek() === "all" ? "one" : "off");
}

function step(dir: 1 | -1): number {
    const at = order.indexOf(index.peek());
    const next = at + dir;
    if (next >= 0 && next < order.length) return order[next];
    if (repeat.peek() === "all" && order.length) return order[dir > 0 ? 0 : order.length - 1];
    return -1;
}

export function next(): void {
    const i = step(1);
    if (i < 0) return stop();
    index.set(i);
    load(0, true);
}

export function previous(): void {
    if (position.peek() > 3) return seek(0);
    const i = step(-1);
    if (i < 0) return seek(0);
    index.set(i);
    load(0, true);
}

export function jump(i: number): void {
    if (i < 0 || i >= queue.peek().length) return;
    index.set(i);
    load(0, true);
}

// ---------------------------------------------------------------- playing

/** Stopped, for the song the session was playing: next() and the like have
 * already moved the index to the new one when load() calls this. */
function finishReport(): void {
    if (sessionItem && session) jf.reportStop(sessionItem, session, position.peek());
    session = "";
    sessionItem = "";
}

function release(): void {
    if (!audio) return;
    audio.onended = audio.onerror = audio.onplay = null;
    audio.pause();
    audio.src = ""; // lets go of the decoder and the network stream
    audio = null;
}

/** Starts the current song at `at` seconds. */
function load(at: number, fresh: boolean): void {
    const t = now();
    finishReport();
    release();
    endWait();
    if (fresh) retries = 0;
    problem.set(null);
    if (!t) return;
    const kbps = settings.kbps.peek();
    let a: Audio;
    if (settings.mode.peek() === "stream") {
        a = new Audio(jf.audioUrl(t.Id, kbps, at));
        offset = at;
    } else {
        const path = ensureDownload(t);
        a = new Audio(path);
        if (at > 0) a.currentTime = at; // the decoder seeks by the bitrate once it has the first frame
        offset = 0;
    }
    audio = a;
    console.log(`hexamp: ${settings.mode.peek()} "${t.Name}" from ${Math.round(at)} s`);
    a.onended = () => songOver(`ended at ${Math.round(offset + a.currentTime)} s`);
    a.onerror = () => {
        console.warn(`hexamp: "${t.Name}": ${a.error ? a.error.message : "error"}`);
        if (audio !== a) return; // an Audio let go of already
        // the network stopped (sleep, Wi-Fi lost) or the download failed: once more from here
        const where = position.peek();
        if (!playing.peek()) return; // paused (asleep): play() starts it over from here
        // the stream broke off at the very end (a server closing early): the
        // song is over (one that never started was not cut off: a short song)
        const d = jf.seconds(t);
        if (d && where > 0 && where >= d - 4) return songOver("cut off at the end");
        // no network: the song waits for it, without using up its tries
        if (net.status() !== "connected") return waitForNetwork(where);
        const s = session;
        if (retries++ < 3) return void setTimeout(() => session === s && load(where, false), 2000);
        problem.set(a.error ? a.error.message : "the song could not be played");
        setPlaying(false);
    };
    batch(() => {
        position.set(at);
        buffering.set(true);
    });
    setPlaying(true);
    session = Math.floor(Math.random() * 2 ** 32).toString(16); // before play(): its error may come at once
    sessionItem = t.Id;
    jf.reportStart(t.Id, session);
    lastReport = Date.now();
    a.play().catch(e => {
        console.warn(`hexamp: "${t.Name}" did not start: ${e.message ?? e}`);
        if (audio !== a || a.error) return; // onerror has seen to it (waiting for the network, or trying again)
        problem.set(String(e.message ?? e));
        setPlaying(false);
    });
    tidyCache();
}

/** No network: the song waits where it stopped (playing, as far as the
 * user is concerned) until it is back, at most WAIT_MAX_MS. */
function waitForNetwork(at: number): void {
    release();
    endWait();
    waitingAt = at;
    console.log(`hexamp: no network: waiting at ${Math.round(at)} s`);
    batch(() => {
        position.set(at);
        buffering.set(true);
    });
    waitTimer = setTimeout(() => {
        endWait();
        problem.set("The network did not come back.");
        batch(() => {
            setPlaying(false);
            buffering.set(false);
        });
    }, WAIT_MAX_MS);
}

function endWait(): void {
    waitingAt = -1;
    clearTimeout(waitTimer);
}

/** The network is back: the song waiting for it goes on from where it
 * stopped, and one stuck on a connection the drop broke starts over. */
export function networkBack(): void {
    if (waitingAt >= 0) {
        const at = waitingAt;
        endWait();
        if (playing.peek() && now()) load(at, true);
        return;
    }
    if (audio && playing.peek() && audio.buffering && settings.mode.peek() === "stream") load(position.peek(), true);
}

/** The song is over: the next one (or this one again, or the end of the queue). */
let overAt = "";
function songOver(why: string): void {
    const t = now();
    if (!t || overAt === session) return; // once per play
    overAt = session;
    console.log(`hexamp: "${t.Name}" ${why}`);
    if (repeat.peek() === "one") return load(0, true);
    next();
}

function setPlaying(on: boolean): void {
    playing.set(on);
    system.keepAwake(on); // no auto-sleep in the middle of a song
}

export function toggle(): void {
    if (!now()) return;
    if (playing.peek()) return pause();
    if (!audio || audio.ended || audio.error) return load(position.peek(), true);
    setPlaying(true);
    audio.play().catch(() => {});
    // the server shows it paused until told otherwise (a remote's view of it too)
    const t = now();
    if (t && session) {
        jf.reportProgress(t.Id, session, position.peek(), false);
        lastReport = Date.now();
    }
}

/** Plays when paused; nothing when already playing (a remote's Unpause). */
export function resume(): void {
    if (!playing.peek()) toggle();
}

export function pause(): void {
    if (waitingAt >= 0) { // waiting for the network: not any more
        endWait();
        batch(() => {
            setPlaying(false);
            buffering.set(false);
        });
        return;
    }
    if (!audio) return;
    audio.pause();
    setPlaying(false);
    const t = now();
    if (t && session) jf.reportProgress(t.Id, session, position.peek(), true);
}

export function stop(): void {
    finishReport();
    release();
    endWait();
    batch(() => {
        setPlaying(false);
        position.set(0);
        buffering.set(false);
    });
}

export function seek(s: number): void {
    const d = (now() ? jf.seconds(now()!) : 0);
    s = Math.max(0, d ? Math.min(s, d - 1) : s);
    if (!audio) return load(s, false);
    if (settings.mode.peek() === "stream") return load(s, false); // the server starts over from there
    audio.currentTime = s;
    position.set(s);
}

// ---------------------------------------------------------------- downloads (download mode)

function ensureDownload(t: Item): string {
    const path = `${CACHE}/${t.Id}.mp3`;
    if (!downloads.has(t.Id) && !completed.has(t.Id)) {
        const d = net.download(jf.audioUrl(t.Id, settings.kbps.peek()), path, { headers: jf.authHeaders() });
        downloads.set(t.Id, d);
        d.done.then(() => {
            completed.add(t.Id);
            prefetch();
        }, () => {}).finally(() => downloads.delete(t.Id));
    }
    return path;
}

const completed = new Set<string>(); // on the card from this run

/** The next song, once the current one is on the card. */
function prefetch(): void {
    if (settings.mode.peek() !== "download") return;
    const cur = now();
    if (!cur || downloads.size || !completed.has(cur.Id)) return;
    const i = step(1);
    const n = i >= 0 ? queue.peek()[i] : null;
    if (n && !completed.has(n.Id)) ensureDownload(n);
}

/** Only the current song, the next one and those downloading stay in the cache. */
function tidyCache(): void {
    if (settings.mode.peek() !== "download") return;
    const keep = new Set<string>([...downloads.keys()]);
    const cur = now();
    if (cur) keep.add(cur.Id);
    const i = step(1);
    if (i >= 0) keep.add(queue.peek()[i].Id);
    for (const [id, d] of downloads) if (!keep.has(id)) d.abort();
    fs.list(CACHE).then(names => {
        for (const n of names) {
            const id = n.replace(/\.mp3$/, "");
            if (!keep.has(id)) {
                completed.delete(id);
                fs.remove(`${CACHE}/${n}`).catch(() => {});
            }
        }
    }, () => {});
}

export async function clearSongCache(): Promise<void> {
    for (const d of downloads.values()) d.abort();
    completed.clear();
    for (const n of await fs.list(CACHE).catch(() => [] as string[])) await fs.remove(`${CACHE}/${n}`).catch(() => {});
}

// ---------------------------------------------------------------- the clock

export function start(): void {
    fs.mkdir(CACHE).catch(() => {});
    setInterval(() => {
        const a = audio;
        if (!a) return;
        const t = offset + a.currentTime;
        batch(() => {
            if (Math.abs(t - position.peek()) >= 0.25) position.set(t);
            buffering.set(playing.peek() && a.buffering);
        });
        // a stream that never says it ended (its length unknown to the
        // decoder): the song's own length from the server decides
        const song = now(), d = song ? jf.seconds(song) : 0;
        if (playing.peek() && d > 0) {
            if (t !== lastTime) {
                lastTime = t;
                stillSince = Date.now();
            } else if (t >= d - 2 && Date.now() - stillSince > 2500) {
                songOver("stopped at its end");
            }
            if (t >= d + 3) songOver("ran past its length");
        }
        const cur = now();
        if (cur && session && playing.peek() && Date.now() - lastReport > 10000) {
            lastReport = Date.now();
            jf.reportProgress(cur.Id, session, t, false);
        }
    }, 250);

    // sleep: the network stops, so the music does too; on waking it is off
    // until the user plays again (then it starts over from where it was)
    app.on("suspend", () => {
        if (audio) audio.pause();
        endWait();
        setPlaying(false);
    });
    app.on("exit", () => finishReport());
}
