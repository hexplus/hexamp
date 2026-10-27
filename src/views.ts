// The screens: home, favourites, mixes, albums, an album, settings, the
// player and the queue. Each is a function returning markup; data comes
// from the server into signals, and the markup follows them.

import { app, fs, net, power } from "@pspx/native";
import { document, effect, For, html, onCleanup, signal, untrack, type Child, type PspxCanvasElement, type PspxElement, type PspxKeyEvent, type Signal } from "@pspx/ui";
import { clearCovers, cover } from "./art";
import { ACCENT_B, drawPlayButton, drawProgress, icon, type IconName } from "./icons";
import * as jf from "./jellyfin";
import type { Item } from "./jellyfin";
import * as player from "./player";
import { wifiPage } from "./wifi";

// ---------------------------------------------------------------- navigation

export type View =
    | { name: "home" } | { name: "favorites" } | { name: "mix" } | { name: "albums" } | { name: "settings" }
    | { name: "album"; album: Item } | { name: "player" } | { name: "queue" } | { name: "search" } | { name: "libraries" }
    | { name: "wifi" } | { name: "genres" } | { name: "artists" } | { name: "artist"; artist: Item };

/** L and R page through a view that has pages (the albums); elsewhere they change the song. */
export let pager: ((dir: 1 | -1) => void) | null = null;

export const view = signal<View>({ name: "home" });
const history: View[] = [];

export function go(v: View): void {
    const cur = view.peek();
    if (cur.name === v.name && v.name !== "album") return;
    history.push(cur);
    if (history.length > 20) history.shift();
    view.set(v);
}

export function back(): void {
    const v = history.pop();
    if (v) view.set(v);
}

/** Sidebar tabs: the view replaces the history. */
function tab(v: View): void {
    history.length = 0;
    view.set(v);
}

export function togglePlayer(): void {
    const n = view.peek().name;
    if (n === "player" || n === "queue") back();
    else if (player.current.peek()) go({ name: "player" });
}

/** The page the sidebar marks: under the player and the queue, the one they were opened from. */
function pageView(): View {
    const v = view();
    const over = (x: View) => x.name === "player" || x.name === "queue";
    if (!over(v)) return v;
    for (let i = history.length - 1; i >= 0; i--) if (!over(history[i])) return history[i];
    return v;
}

/** Focuses the element once it is on screen (a view just built). */
const focusSoon = (el: PspxElement) => queueMicrotask(() => el.focus());

// What had the focus when the last button went down (before the focus
// moves): where a focus that arrives somewhere came from.
let focusFrom: PspxElement | null = null;
document.addEventListener("keydown", () => { focusFrom = document.activeElement as PspxElement | null; });

/** For each item of a group (the sidebar, the A-Z index): the focus coming
 * into the group from outside lands on its active item (class "on"). */
function landOnActive(group: string) {
    return (el: PspxElement) => el.addEventListener("focus", () => {
        const g = el.closest(group) as PspxElement | null;
        if (!g || el.classList.contains("on") || (focusFrom && g.contains(focusFrom))) return;
        (g.querySelector(".on") as PspxElement | null)?.focus();
    });
}

// ---------------------------------------------------------------- notices

const notice = signal<{ text: string; error: boolean } | null>(null);
let noticeTimer = 0;

/** A line near the bottom of the screen for a few seconds. */
export function notify(text: string, error = false): void {
    notice.set({ text, error });
    clearTimeout(noticeTimer);
    noticeTimer = setTimeout(() => notice.set(null), error ? 5000 : 2500);
}

export function noticeOverlay(): Child {
    return html`<div class="toast-wrap">${() => {
        const n = notice();
        return n ? html`<div class=${n.error ? "toast error" : "toast"}><text>${n.text}</text></div>` : null;
    }}</div>`;
}

// ---------------------------------------------------------------- data

interface Resource<T> {
    data: Signal<T | null>;
    error: Signal<string | null>;
}

function load<T>(fetch: () => Promise<T>): Resource<T> {
    const r: Resource<T> = { data: signal<T | null>(null), error: signal<string | null>(null) };
    fetch().then(v => r.data.set(v), e => r.error.set(String(e?.message ?? e)));
    return r;
}

/** Grey stand-ins while the real thing loads. */
function skeletonCards(n: number, cls = "card"): Child {
    return [...Array(n)].map(() => html`<div class=${cls + " skeleton"}><div class="cover sk"></div><div class="sk-line"></div><div class="sk-line short"></div></div>`);
}

function skeletonRows(n: number): Child {
    return html`<div class="list">${[...Array(n)].map(() => html`<div class="row skeleton"><div class="thumb sk"></div><div class="meta"><div class="sk-line"></div><div class="sk-line short"></div></div></div>`)}</div>`;
}

function status<T>(r: Resource<T>, empty: string, body: (v: T) => Child, loading: Child = skeletonRows(3)): Child {
    return () => {
        const e = r.error();
        if (e) return html`<text class="note error">Could not load: ${e}</text>`;
        const v = r.data();
        if (v === null) return loading;
        if (Array.isArray(v) && v.length === 0) return html`<text class="note">${empty}</text>`;
        return body(v);
    };
}

// ---------------------------------------------------------------- pieces

function art(item: Item, size: number, cls: string): Child {
    const c = cover(item, size);
    return () => {
        const p = c();
        return p
            ? html`<img class=${cls} src=${p} />`
            : html`<div class=${cls + " ph"}>${icon("music", Math.min(28, Math.floor(size / 3)), "#5d5d75")}</div>`;
    };
}

function trackRow(t: Item, list: Item[], i: number, showArt = true): Child {
    const isCurrent = () => player.current()?.Id === t.Id;
    return html`<div class=${() => ({ row: true, now: isCurrent() })} onClick=${() => {
        player.playList(list, i);
        go({ name: "player" });
    }}>
        ${showArt ? art(t, 64, "thumb") : html`<text class="num">${i + 1}</text>`}
        <div class="meta">
            <text class="name">${t.Name}</text>
            <text class="sub">${jf.artists(t)}</text>
        </div>
        ${() => (isCurrent() && player.playing() ? icon("radio", 14, ACCENT_B) : "")}
        <text class="dur">${jf.clock(jf.seconds(t))}</text>
    </div>`;
}

/**
 * A list built a few rows at a time: on a PSP a row takes a few ms to
 * build, so a long list (search results, 200 favourites) built at once
 * would hold the screen for seconds, and past 5 s the watchdog stops the
 * app. The first rows show at once, the rest follow frame by frame.
 */
function progressive<T>(items: readonly T[], row: (item: T, i: number) => Child, first = 10, step = 6): Child {
    const shown = signal(Math.min(first, items.length));
    let timer = 0;
    const grow = () => {
        const n = shown.peek();
        if (n >= items.length) return;
        shown.set(Math.min(items.length, n + step));
        timer = setTimeout(grow, 16);
    };
    if (items.length > first) timer = setTimeout(grow, 16);
    onCleanup(() => clearTimeout(timer));
    return html`<div class="list"><${For} each=${() => items.slice(0, shown())}>${(item: T, i: { (): number }) => row(item, i())}<//></div>`;
}

function trackList(tracks: Item[], showArt = true): Child {
    return progressive(tracks, (t, i) => trackRow(t, tracks, i, showArt));
}

function albumCard(a: Item, big = false): Child {
    return html`<div class=${big ? "card big" : "card"} onClick=${() => go({ name: "album", album: a })}>
        ${art(a, big ? 128 : 96, "cover")}
        <text class="cname">${a.Name}</text>
        <text class="csub">${a.AlbumArtist ?? ""}</text>
    </div>`;
}

function pill(label: string, fn: () => void, iconName?: IconName): Child {
    return html`<div class="pill" onClick=${fn}>${iconName ? icon(iconName, 14) : ""}<text>${label}</text></div>`;
}

// ---------------------------------------------------------------- home

function home(): Child {
    const latest = load(() => jf.latestAlbums(10));
    const favs = load(() => jf.favorites());
    const s = jf.session;
    return html`<div class="view">
        <div class="head">
            <text class="title">Music</text>
            <text class="server">${s ? `${s.userName} · ${s.serverName}` : ""}</text>
        </div>
        <div class="bar"><text class="section">Recently added</text><span class="all" onClick=${() => go({ name: "albums" })}>All</span></div>
        ${status(latest, "No albums yet.", v => html`<div class="shelf">${v.map((a, i) => albumCard(a, i === 0))}</div>`,
                 html`<div class="shelf">${skeletonCards(1, "card big")}${skeletonCards(4)}</div>`)}
        <div class="bar"><text class="section">Favourites</text><span class="all" onClick=${() => go({ name: "favorites" })}>All</span></div>
        ${status(favs, "", f => (noFavorites(f) ? html`<text class="note">${NO_FAVORITES}</text>` : html`<div class="list">
            ${f.albums.length ? html`<div class="shelf">${f.albums.slice(0, 10).map(a => albumCard(a))}</div>` : ""}
            ${f.songs.length ? trackList(f.songs.slice(0, 8)) : ""}
        </div>`))}
    </div>`;
}

// ---------------------------------------------------------------- lists

const NO_FAVORITES = "No favourites yet: △ on the player marks the song playing, ♡ on an album the album.";
const noFavorites = (f: jf.Favorites) => !f.albums.length && !f.artists.length && !f.songs.length;

function favorites(): Child {
    const favs = load(() => jf.favorites());
    const group = (title: string, body: Child) => html`<div class="list"><text class="section">${title}</text>${body}</div>`;
    return html`<div class="view">
        <div class="head"><text class="title">Favourites</text></div>
        ${status(favs, "", f => (noFavorites(f) ? html`<text class="note">${NO_FAVORITES}</text>` : html`<div class="list">
            ${f.albums.length ? group("Albums", html`<div class="shelf">${f.albums.map(a => albumCard(a))}</div>`) : ""}
            ${f.artists.length ? group("Artists", html`<div class="shelf">${f.artists.map(artistCard)}</div>`) : ""}
            ${f.songs.length ? group("Songs", html`<div class="list">
                <div class="actions">
                    ${pill("Play all", () => { player.playList(f.songs, 0); go({ name: "player" }); }, "play")}
                    ${pill("Shuffle", () => { player.playList(f.songs, 0, true); go({ name: "player" }); }, "shuffle")}
                </div>
                ${trackList(f.songs)}
            </div>`) : ""}
        </div>`))}
    </div>`;
}

function mixes(): Child {
    const recent = load(() => jf.recentlyPlayed(20));
    const mixOf = (fetch: () => Promise<Item[]>) => () => {
        fetch().then(items => {
            if (!items.length) return;
            player.playList(items, 0);
            go({ name: "player" });
        }, () => {});
    };
    return html`<div class="view">
        <div class="head"><text class="title">Mixes</text></div>
        <div class="actions">
            ${pill("Shuffle everything", mixOf(() => jf.randomTracks(60)), "shuffle")}
            ${() => {
                const c = player.current();
                return c ? pill("Mix from this song", mixOf(() => jf.instantMix(c.Id)), "radio") : "";
            }}
        </div>
        <div class="bar"><text class="section">Recently played</text></div>
        ${status(recent, "Nothing played yet.", v => trackList(v))}
    </div>`;
}

const ALBUMS_PER_PAGE = 8; // two rows of four
const albumPage = signal(0); // kept while the app runs: back from an album lands on the same page
const albumFilter = signal<jf.AlbumFilter>({ ...jf.NO_FILTER });
const albumLetter = signal<Picked | null>(null);
const LETTERS = "#ABCDEFGHIJKLMNOPQRSTUVWXYZ";
const SORTS: { sort: jf.AlbumFilter["sort"]; label: string }[] = [
    { sort: "name", label: "A–Z" }, { sort: "added", label: "Newest" }, { sort: "year", label: "Year" },
];
const DECADES = [null, 2020, 2010, 2000, 1990, 1980, 1970, 1960];

function setFilter(change: Partial<jf.AlbumFilter>): void {
    albumFilter.set({ ...albumFilter.peek(), ...change });
    albumPage.set(0);
}

interface Picked {
    letter: string;
    page: number;
}

/** The index letter a name files under ("#" for digits and signs). */
function letterOf(item: Item): string {
    const c = (item.SortName || item.Name || "").trim().charAt(0).toUpperCase();
    return c >= "A" && c <= "Z" ? c : "#";
}

interface PagedGrid {
    title: string;
    page: Signal<number>;
    fetch: (start: number, limit: number) => Promise<{ items: Item[]; total: number }>;
    /** The A-Z index: where a letter's first item stands (none: no index). */
    indexOf?: (letter: string) => Promise<number>;
    letters?: () => boolean;
    /** The letter last chosen in the index, and the page it led to (kept while the app runs). */
    picked?: Signal<Picked | null>;
    card: (item: Item) => Child;
    empty: string;
    filters?: Child;
    /** Signals whose change means a new list (the filters): from the first page. */
    watch?: () => unknown;
}

/** Pages numbers to show around the current one: 1 … 4 5 [6] 7 8 … 20 */
function pageNumbers(current: number, count: number): (number | null)[] {
    const out: (number | null)[] = [];
    for (let p = 0; p < count; p++) {
        if (p === 0 || p === count - 1 || Math.abs(p - current) <= 2) out.push(p);
        else if (out[out.length - 1] !== null) out.push(null);
    }
    return out;
}

/** A grid of 8 cards a page: pagination (L and R, and the bar below), and an A-Z index. */
function pagedGrid(o: PagedGrid): Child {
    const items = signal<Item[] | null>(null);
    const total = signal(0);
    const error = signal<string | null>(null);
    const firstLetter = signal<string | null>(null); // of the page's first card, once it is in
    let asked = 0;
    const pages = () => Math.max(1, Math.ceil(total() / ALBUMS_PER_PAGE));
    // the index's active letter: the one chosen while its page shows, else the page's own
    const activeLetter = () => {
        const pick = o.picked?.();
        return pick && pick.page === o.page() ? pick.letter : firstLetter();
    };
    const show = (p: number, focusFirst = true) => {
        const n = ++asked;
        o.page.set(p);
        items.set(null);
        error.set(null);
        o.fetch(p * ALBUMS_PER_PAGE, ALBUMS_PER_PAGE).then(r => {
            if (n !== asked) return; // a later page was asked for meanwhile
            total.set(r.total);
            items.set(r.items);
            firstLetter.set(r.items.length ? letterOf(r.items[0]) : null);
            if (focusFirst) queueMicrotask(() => (document.querySelector(".grid4 .card") as PspxElement | null)?.focus());
        }, e => error.set(String(e.message ?? e)));
    };
    let first = true;
    effect(() => {
        o.watch?.();
        const p = untrack(() => o.page.peek());
        if (first) {
            first = false;
            show(p);
        } else {
            o.picked?.set(null);
            show(0, false); // new filters: from the first page
        }
    });
    pager = dir => {
        const p = o.page.peek() + dir;
        if (p >= 0 && p < pages()) show(p);
    };
    onCleanup(() => { pager = null; });
    const jump = (letter: string) => {
        o.indexOf?.(letter).then(i => {
            const page = Math.floor(i / ALBUMS_PER_PAGE);
            o.picked?.set({ letter, page });
            show(page);
        }, () => {});
    };
    const pg = (label: string, target: () => number, on: () => boolean, enabled: () => boolean) =>
        html`<div class=${() => ({ pg: true, on: on(), off: !enabled() })} onClick=${() => { if (enabled()) show(target()); }}><text>${label}</text></div>`;
    return html`<div class="view">
        <div class="head">
            <text class="title">${o.title}</text>
            <text class="server">${() => (total() ? `L «  page ${o.page() + 1} of ${pages()}  » R` : "")}</text>
        </div>
        ${o.filters ?? ""}
        ${() => (o.indexOf && (o.letters ? o.letters() : true)
            ? html`<div class="letters">${[...LETTERS].map(l => html`<div class=${() => ({ letter: true, on: activeLetter() === l })}
                    onClick=${() => jump(l)} ref=${landOnActive(".letters")}><text>${l}</text></div>`)}</div>`
            : "")}
        <div class="grid4">${() => {
            if (error()) return html`<text class="note error">Could not load: ${error()}</text>`;
            const v = items();
            if (!v) return skeletonCards(ALBUMS_PER_PAGE);
            if (!v.length) return html`<text class="note">${o.empty}</text>`;
            return v.map(o.card);
        }}</div>
        <div class="pager">${() => {
            const count = pages(), cur = o.page();
            if (count < 2) return "";
            return [
                pg("‹ Previous", () => cur - 1, () => false, () => cur > 0),
                ...pageNumbers(cur, count).map(p => (p === null
                    ? html`<text class="gap">…</text>`
                    : pg(String(p + 1), () => p, () => p === cur, () => true))),
                pg("Next ›", () => cur + 1, () => false, () => cur < count - 1),
            ];
        }}</div>
    </div>`;
}

function albums(): Child {
    const f = albumFilter;
    const chip = (label: () => string, on: () => boolean, fn: () => void) =>
        html`<div class=${() => ({ chip: true, on: on() })} onClick=${fn}><text>${label}</text></div>`;
    return pagedGrid({
        title: "Albums",
        page: albumPage,
        picked: albumLetter,
        fetch: (start, limit) => jf.albums(start, limit, albumFilter.peek()),
        indexOf: letter => jf.albumIndexOf(letter, albumFilter.peek()),
        letters: () => f().sort === "name",
        card: a => albumCard(a),
        empty: "No albums match (the filters above, or the libraries in Settings).",
        watch: () => albumFilter(),
        filters: html`<div class="chips">
            ${chip(() => SORTS.find(s => s.sort === f().sort)!.label, () => f().sort !== "name", () => {
                const i = SORTS.findIndex(s => s.sort === f.peek().sort);
                setFilter({ sort: SORTS[(i + 1) % SORTS.length].sort });
            })}
            ${chip(() => "Favourites", () => f().favourites, () => setFilter({ favourites: !f.peek().favourites }))}
            ${chip(() => f().genre ?? "All genres", () => !!f().genre, () => go({ name: "genres" }))}
            ${chip(() => (f().decade ? `${f().decade}s` : "All years"), () => !!f().decade, () => {
                const i = DECADES.indexOf(f.peek().decade);
                setFilter({ decade: DECADES[(i + 1) % DECADES.length] });
            })}
        </div>`,
    });
}

const artistPage = signal(0);
const artistLetter = signal<Picked | null>(null);

function artistCard(a: Item): Child {
    return html`<div class="card" onClick=${() => go({ name: "artist", artist: a })}>
        ${art(a, 96, "cover round")}
        <text class="cname center">${a.Name}</text>
    </div>`;
}

function artists(): Child {
    return pagedGrid({
        title: "Artists",
        page: artistPage,
        picked: artistLetter,
        fetch: (start, limit) => jf.albumArtists(start, limit),
        indexOf: letter => jf.artistIndexOf(letter),
        card: artistCard,
        empty: "No artists in the libraries chosen (Settings).",
    });
}

function artist(a: Item): Child {
    const list = load(() => jf.artistAlbums(a.Id));
    // the artist's songs, shuffled: asked for when pressed, not with the page
    const shuffle = () => {
        jf.artistTracks(a.Id).then(items => {
            if (!items.length) return notify(`No songs by ${a.Name} in the libraries chosen.`);
            player.playList(items, 0, true);
            go({ name: "player" });
        }, e => notify(`Could not load ${a.Name}'s songs: ${(e as Error).message}`, true));
    };
    return html`<div class="view">
        <div class="head"><text class="title">${a.Name}</text><text class="server">${() => {
            const v = list.data();
            return v ? `${v.length} album${v.length === 1 ? "" : "s"}` : "";
        }}</text></div>
        <div class="actions">${pill("Shuffle", shuffle, "shuffle")}</div>
        ${status(list, "No albums.", v => html`<div class="grid4">${v.map((x, i) => {
            const card = albumCard(x) as PspxElement;
            if (i === 0) focusSoon(card);
            return card;
        })}</div>`, html`<div class="grid4">${skeletonCards(4)}</div>`)}
    </div>`;
}

function genresView(): Child {
    const genres = load(() => jf.musicGenres());
    const pick = (g: string | null) => {
        setFilter({ genre: g });
        back();
    };
    return html`<div class="view">
        <div class="head"><text class="title">Genre</text></div>
        ${status(genres, "The libraries have no genres.", v => html`<div class="list">
            <div class="row" onClick=${() => pick(null)} ref=${focusSoon}><div class="meta"><text class="name">All genres</text></div></div>
            ${v.map(g => html`<div class=${() => ({ row: true, now: albumFilter().genre === g })} onClick=${() => pick(g)}>
                <div class="meta"><text class="name">${g}</text></div>
            </div>`)}
        </div>`)}
    </div>`;
}

function album(a: Item): Child {
    const tracks = load(() => jf.albumTracks(a.Id));
    return html`<div class="view row-view">
        <div class="album-side">
            ${art(a, 128, "cover-big")}
            <text class="aname">${a.Name}</text>
            <text class="sub">${a.AlbumArtist ?? ""}${a.ProductionYear ? ` · ${a.ProductionYear}` : ""}</text>
            ${status(tracks, "", v => html`<div class="album-actions">
                ${html`<div class="pill" onClick=${() => { player.playList(v, 0); go({ name: "player" }); }} ref=${focusSoon}>${icon("play", 14)}<text>Play</text></div>`}
                <div class="pill-row">
                    ${pill("Shuffle", () => { player.playList(v, 0, true); go({ name: "player" }); }, "shuffle")}
                    ${favoritePill(a)}
                </div>
            </div>`)}
        </div>
        <div class="album-tracks">
            ${status(tracks, "No songs.", v => trackList(v, false))}
        </div>
    </div>`;
}

// ---------------------------------------------------------------- settings

function settings(onSignOut: () => void): Child {
    const usage = signal("…");
    const refreshUsage = () =>
        fs.usage().then(u => usage.set(`${(u.cache / 1048576).toFixed(1)} of ${(u.cacheQuota / 1048576).toFixed(0)} MB`), () => {});
    refreshUsage();
    // the battery, read again every 20 s while the page is open
    const readBattery = () => {
        const p = power.batteryPercent();
        return p === null ? "unknown" : `${p}%${power.isCharging() ? ", charging" : ""}`;
    };
    const battery = signal(readBattery());
    const batteryTimer = setInterval(() => battery.set(readBattery()), 20000);
    onCleanup(() => clearInterval(batteryTimer));
    const s = jf.session;
    const setting = (label: string, value: () => string, fn: () => void) => html`<div class="row" onClick=${fn}>
        <div class="meta"><text class="name">${label}</text></div>
        <text class="value">${value}</text>
    </div>`;
    return html`<div class="view">
        <div class="head"><text class="title">Settings</text></div>
        <div class="list">
            <div class="row info"><div class="meta"><text class="name">${s?.serverName ?? ""}</text><text class="sub">${s?.server ?? ""}</text></div><text class="value">${s?.userName ?? ""}</text></div>
            ${setting("Playback", () => (player.settings.mode() === "stream" ? "Streaming" : "Download, then play"), () =>
                player.setMode(player.settings.mode.peek() === "stream" ? "download" : "stream"))}
            ${setting("Quality", () => `${player.settings.kbps()} kbps MP3`, () => {
                const q = [96, 128, 192, 256];
                player.setBitrate(q[(q.indexOf(player.settings.kbps.peek()) + 1) % q.length]);
            })}
            ${setting("Wi-Fi", () => net.info()?.ssid ?? "not connected", () => go({ name: "wifi" }))}
            ${setting("Libraries", () => {
                const n = jf.chosenLibraries().length;
                return n ? `${n} chosen` : "All music";
            }, () => go({ name: "libraries" }))}
            ${setting("Battery", battery, () => battery.set(readBattery()))}
            ${setting("Cache (covers, downloads)", usage, () => {
                clearCovers().then(() => player.clearSongCache()).then(refreshUsage);
            })}
            ${setting("Sign out", () => "", () => {
                player.stop();
                jf.signOut().then(onSignOut);
            })}
            ${setting("Exit", () => "", () => app.exit())}
        </div>
        <text class="note">Streaming plays at once from the network. Download, then play keeps each song on the Memory Stick as it arrives, and gets the next one ready.</text>
    </div>`;
}

// ---------------------------------------------------------------- the player

function playerView(): Child {
    let playCanvas: PspxCanvasElement | null = null;
    let progress: PspxCanvasElement | null = null;
    let playFocused = false, barFocused = false;
    const redrawPlay = () => playCanvas && drawPlayButton(playCanvas, player.playing(), playFocused);
    const redrawBar = () => {
        const d = player.duration();
        if (progress) drawProgress(progress, d ? player.position() / d : 0, barFocused);
    };
    const button = (name: () => IconName, fn: () => void, on: () => boolean = () => false) =>
        html`<div class="ctl" onClick=${fn}>${() => icon(name(), 20, on() ? ACCENT_B : "#d8d8e4")}</div>`;
    // a hole of its own: a function returned from a hole would be called once
    return html`<div class="grow">${() => {
        const t = player.current();
        if (!t) return html`<div class="view"><text class="note">Nothing is playing.</text></div>`;
        // the album's year: the song's own, else the album's (asked for once)
        const year = signal<number | null>(t.ProductionYear ?? null);
        if (!t.ProductionYear && t.AlbumId) jf.albumYear(t.AlbumId).then(y => year.set(y), () => {});
        return html`<div class="player">
            <div class="pl-art">${art(t, 256, "pl-cover")}</div>
            <div class="pl-side">
                <text class="pl-title">${t.Name}</text>
                <text class="pl-artist">${jf.artists(t)}</text>
                <text class="pl-album">${() => [t.Album ?? "", year() ?? ""].filter(Boolean).join(" · ")}</text>
                <canvas class="progress" width="220" height="14" focusable ref=${(el: PspxCanvasElement) => {
                    progress = el;
                    untrack(redrawBar);
                    el.addEventListener("focus", () => { barFocused = true; redrawBar(); });
                    el.addEventListener("blur", () => { barFocused = false; redrawBar(); });
                    el.addEventListener("keydown", e => {
                        if (e.key === "ArrowLeft") player.seek(player.position.peek() - 10);
                        if (e.key === "ArrowRight") player.seek(player.position.peek() + 10);
                    });
                }}></canvas>
                ${() => { redrawBar(); return ""; }}
                <div class="times">
                    <text class="time">${() => jf.clock(player.position())}</text>
                    <text class="time">${() => (player.buffering() ? "buffering…" : "")}</text>
                    <text class="time">${() => jf.clock(player.duration())}</text>
                </div>
                <div class="controls">
                    ${button(() => "prev", player.previous)}
                    <canvas class="playbtn" width="44" height="44" focusable onClick=${player.toggle} ref=${(el: PspxCanvasElement) => {
                        playCanvas = el;
                        untrack(redrawPlay);
                        el.addEventListener("focus", () => { playFocused = true; redrawPlay(); });
                        el.addEventListener("blur", () => { playFocused = false; redrawPlay(); });
                        focusSoon(el);
                    }}></canvas>
                    ${() => { redrawPlay(); return ""; }}
                    ${button(() => "next", player.next)}
                </div>
                <div class="rule"></div>
                <div class="extras">
                    ${button(() => (player.repeat() === "one" ? "repeat-one" : "repeat"), player.cycleRepeat, () => player.repeat() !== "off")}
                    ${button(() => "shuffle", player.toggleShuffle, player.shuffle)}
                    ${favoriteButton(t)}
                    ${button(() => "queue", () => go({ name: "queue" }))}
                </div>
                ${() => (player.problem() ? html`<text class="note error">${player.problem()}</text>` : "")}
            </div>
        </div>`;
    }}</div>`;
}

// a song's or an album's favourite state, one signal per item for the session
const favorites_ = new Map<string, Signal<boolean>>();
function favoriteSignal(t: Item): Signal<boolean> {
    let s = favorites_.get(t.Id);
    if (!s) favorites_.set(t.Id, (s = signal(!!t.UserData?.IsFavorite)));
    return s;
}

/** Marks a song or an album a favourite (or not) on the server, and says so. */
export function toggleFavorite(t: Item): void {
    const s = favoriteSignal(t);
    const on = !s.peek();
    s.set(on);
    jf.setFavorite(t.Id, on).then(saved => {
        s.set(saved);
        t.UserData = { ...t.UserData, IsFavorite: saved };
        notify(`${t.Name}: ${saved ? "added to" : "taken out of"} the favourites`);
    }, e => {
        s.set(!on);
        console.log(`hexamp: favourite ${t.Id} not saved: ${e?.message ?? e}`);
        notify(`The favourite was not saved: ${e?.message ?? e}`, true);
    });
}

function favoritePill(a: Item): Child {
    const on = favoriteSignal(a);
    return html`<div class="pill heart" onClick=${() => toggleFavorite(a)}>${() => icon(on() ? "heart-on" : "heart", 14, on() ? ACCENT_B : "#e8e8f0")}</div>`;
}

function favoriteButton(t: Item): Child {
    const on = favoriteSignal(t);
    return html`<div class="ctl" onClick=${() => toggleFavorite(t)}>${() => icon(on() ? "heart-on" : "heart", 20, on() ? ACCENT_B : "#d8d8e4")}</div>`;
}

function queueView(): Child {
    return html`<div class="view">
        <div class="head"><text class="title">Queue</text><text class="server">${() => `${player.queue().length} songs`}</text></div>
        <div class="list">
            ${() => player.queue().map((t, i) => html`<div class=${() => ({ row: true, now: player.index() === i })}
                    onClick=${() => { player.jump(i); back(); }} ref=${(el: PspxElement) => { if (player.index.peek() === i) focusSoon(el); }}>
                ${art(t, 64, "thumb")}
                <div class="meta"><text class="name">${t.Name}</text><text class="sub">${jf.artists(t)}</text></div>
                <text class="dur">${jf.clock(jf.seconds(t))}</text>
            </div>`)}
        </div>
    </div>`;
}

// ---------------------------------------------------------------- search

const KEYS = ["ABCDEF", "GHIJKL", "MNOPQR", "STUVWX", "YZ0123", "456789"];
const SEARCH_PAUSE_MS = 900; // no request while letters keep coming
const searchTerm = signal("");

function searchView(): Child {
    const results = signal<{ albums: Item[]; songs: Item[] } | null>(null);
    const busy = signal(false);
    let timer = 0, asked = 0;
    const type = (next: string) => {
        searchTerm.set(next.slice(0, 40));
        clearTimeout(timer);
        const term = searchTerm.peek().trim();
        if (term.length < 2) {
            results.set(null);
            return;
        }
        const n = ++asked; // a newer letter makes any search under way stale
        busy.set(true);
        timer = setTimeout(() => { // the server is asked once the typing pauses
            jf.search(term).then(r => {
                if (n === asked) results.set(r);
            }, () => {}).finally(() => { if (n === asked) busy.set(false); });
        }, SEARCH_PAUSE_MS);
    };
    onCleanup(() => clearTimeout(timer));
    if (searchTerm.peek()) type(searchTerm.peek());
    const key = (label: string, fn: () => void, cls = "key") =>
        html`<div class=${cls} onClick=${fn}><text>${label}</text></div>`;
    return html`<div class="view row-view">
        <div class="pad" ref=${(el: PspxElement) => {
            el.addEventListener("keydown", (e: PspxKeyEvent) => {
                if (e.key === "Square") type(searchTerm.peek().slice(0, -1)); // □ rubs out a letter
            });
        }}>
            <div class="query"><text class="qtext">${() => searchTerm() || "Search"}</text></div>
            ${KEYS.map((row, r) => html`<div class="keys">${[...row].map((ch, c) => {
                const k = key(ch, () => type(searchTerm.peek() + ch.toLowerCase())) as PspxElement;
                if (r === 0 && c === 0) queueMicrotask(() => k.focus && k.focus());
                return k;
            })}</div>`)}
            <div class="keys">
                ${key("space", () => type(searchTerm.peek() + " "), "key wide")}
                ${key("←", () => type(searchTerm.peek().slice(0, -1)), "key")}
                ${key("clear", () => type(""), "key wide")}
            </div>
            <text class="hint small">□ rubs out</text>
        </div>
        <div class="results">${() => {
            const r = results();
            if (!r && busy()) return skeletonRows(4); // (busy is read only then: typing does not rebuild the results)
            if (!r) return html`<text class="note">Songs and albums by name: type two letters or more.</text>`;
            if (!r.albums.length && !r.songs.length) return html`<text class="note">Nothing found for “${searchTerm.peek()}”.</text>`;
            // albums first, then songs, built a few at a time
            const all: { album?: Item; song?: Item; i: number }[] = [
                ...r.albums.map((a, i) => ({ album: a, i })),
                ...r.songs.map((t, i) => ({ song: t, i })),
            ];
            return progressive(all, e => (e.album
                ? html`<div class="row" onClick=${() => go({ name: "album", album: e.album! })}>
                    ${art(e.album, 64, "thumb square")}
                    <div class="meta"><text class="name">${e.album.Name}</text><text class="sub">Album · ${e.album.AlbumArtist ?? ""}</text></div>
                </div>`
                : trackRow(e.song!, r.songs, e.i)));
        }}</div>
    </div>`;
}

// ---------------------------------------------------------------- libraries (settings)

function librariesView(): Child {
    const libs = load(() => jf.musicLibraries());
    const chosen = signal(jf.chosenLibraries());
    const toggle = (id: string) => {
        const now = chosen.peek();
        const next = now.includes(id) ? now.filter(x => x !== id) : [...now, id];
        chosen.set(next);
        jf.chooseLibraries(next);
    };
    return html`<div class="view">
        <div class="head"><text class="title">Libraries</text></div>
        <text class="note">The music libraries the app shows. None ticked: all of them.</text>
        ${status(libs, "The server has no music libraries.", v => html`<div class="list">
            ${v.map((l, i) => html`<div class="row" onClick=${() => toggle(l.Id)} ref=${(el: PspxElement) => { if (i === 0) focusSoon(el); }}>
                ${() => icon(chosen().includes(l.Id) ? "check" : "box", 18, chosen().includes(l.Id) ? ACCENT_B : "#8b8ba3")}
                <div class="meta"><text class="name">${l.Name}</text></div>
            </div>`)}
        </div>`)}
    </div>`;
}

// ---------------------------------------------------------------- the shell

function sideTab(name: IconName, v: View, match: (v: View) => boolean): Child {
    return html`<div class=${() => ({ tab: true, on: match(pageView()) })} onClick=${() => tab(v)} ref=${landOnActive(".side")}>${() => icon(name, 20, match(pageView()) ? ACCENT_B : "#9a9ab0")}</div>`;
}

/** The bar at the bottom: the song (✕ opens the player) and its own play / pause button. */
function miniPlayer(): Child {
    return html`<div>${() => {
        const t = player.current();
        if (!t) return "";
        let btn: PspxCanvasElement | null = null, focused = false;
        const redraw = () => btn && drawPlayButton(btn, player.playing(), focused);
        return html`<div class="mini">
            <div class="mini-open" onClick=${() => go({ name: "player" })}>
                ${art(t, 64, "mini-art")}
                <div class="meta">
                    <text class="name">${t.Name}</text>
                    <text class="sub">${jf.artists(t)}</text>
                </div>
                <text class="dur">${() => `${jf.clock(player.position())} / ${jf.clock(player.duration())}`}</text>
            </div>
            <canvas class="mini-btn" width="26" height="26" focusable onClick=${player.toggle} ref=${(el: PspxCanvasElement) => {
                btn = el;
                untrack(redraw);
                el.addEventListener("focus", () => { focused = true; redraw(); });
                el.addEventListener("blur", () => { focused = false; redraw(); });
            }}></canvas>
            ${() => { redraw(); return ""; }}
        </div>`;
    }}</div>`;
}

export function shell(onSignOut: () => void): Child {
    return html`<div class="shell">
        <div class="side">
            ${sideTab("search", { name: "search" }, v => v.name === "search")}
            ${sideTab("home", { name: "home" }, v => v.name === "home")}
            ${sideTab("heart", { name: "favorites" }, v => v.name === "favorites")}
            ${sideTab("radio", { name: "mix" }, v => v.name === "mix")}
            ${sideTab("albums", { name: "albums" }, v => v.name === "albums" || v.name === "album" || v.name === "genres")}
            ${sideTab("mic", { name: "artists" }, v => v.name === "artists" || v.name === "artist")}
            ${sideTab("user", { name: "settings" }, v => v.name === "settings" || v.name === "libraries" || v.name === "wifi")}
        </div>
        <div class="main" onBack=${back}>
            ${() => {
                const v = view();
                switch (v.name) {
                    case "home": return home();
                    case "favorites": return favorites();
                    case "mix": return mixes();
                    case "albums": return albums();
                    case "album": return album(v.album);
                    case "settings": return settings(onSignOut);
                    case "player": return playerView();
                    case "queue": return queueView();
                    case "search": return searchView();
                    case "libraries": return librariesView();
                    case "wifi": return wifiPage(null, back);
                    case "genres": return genresView();
                    case "artists": return artists();
                    case "artist": return artist(v.artist);
                }
            }}
            ${() => (view().name === "player" ? "" : miniPlayer())}
        </div>
    </div>`;
}
