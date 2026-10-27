// The Jellyfin server: sign-in (Quick Connect: the PSP has no keyboard yet),
// the music library, images, playback URLs and reports. Plain fetch over
// http: (PSPX has no TLS), JSON in and out.

const CLIENT = "Hexamp";
const VERSION = "0.1.0";

export interface UserData {
    IsFavorite?: boolean;
    PlayCount?: number;
    LastPlayedDate?: string;
}

export interface Item {
    Id: string;
    Name: string;
    SortName?: string;
    Type?: string;
    Album?: string;
    AlbumId?: string;
    AlbumArtist?: string;
    Artists?: string[];
    RunTimeTicks?: number;
    ProductionYear?: number;
    DateCreated?: string;
    ChildCount?: number;
    ImageTags?: { Primary?: string };
    AlbumPrimaryImageTag?: string;
    UserData?: UserData;
}

export interface Session {
    server: string; // "http://192.168.1.10:8096", no trailing slash
    serverName: string;
    userId: string;
    userName: string;
    token: string;
}

export const deviceId = (() => {
    let id = localStorage.getItem("jf.device");
    if (!id) {
        id = "psp-" + Math.floor(Math.random() * 2 ** 32).toString(16) + Date.now().toString(16);
        localStorage.setItem("jf.device", id);
    }
    return id;
})();

export let session: Session | null = (() => {
    try {
        return JSON.parse(localStorage.getItem("jf.session") ?? "null") as Session | null;
    } catch {
        return null;
    }
})();

export function saveSession(s: Session | null): void {
    session = s;
    if (s) localStorage.setItem("jf.session", JSON.stringify(s));
    else localStorage.removeItem("jf.session");
}

/** The Authorization header Jellyfin wants from a client. */
export function authorization(token?: string): string {
    return `MediaBrowser Client="${CLIENT}", Device="PSP", DeviceId="${deviceId}", Version="${VERSION}"` +
        (token ? `, Token="${token}"` : "");
}

export class ServerError extends Error {
    constructor(message: string, readonly status: number) {
        super(message);
    }
}

// The runtime takes at most 8 requests at once and rejects the ninth (EBUSY).
// Covers hold up to 2 of them (art.ts) and the music up to 2 (a stream, or a
// download and the next song's), so the API's own calls take turns beyond 4.
// (They go out one at a time on the runtime's network thread anyway.)
const MAX_CALLS = 4;
let calls = 0;
const waiting: (() => void)[] = [];

function acquire(): Promise<void> | void {
    if (calls < MAX_CALLS) {
        calls++;
        return;
    }
    return new Promise<void>(resolve => waiting.push(resolve));
}

function release(): void {
    const next = waiting.shift();
    if (next) next(); // the slot goes straight to the next call: none can jump the queue
    else calls--;
}

async function request<T>(server: string, method: string, path: string, body?: unknown, token?: string): Promise<T> {
    await acquire();
    try {
        return await send<T>(server, method, path, body, token);
    } finally {
        release();
    }
}

async function send<T>(server: string, method: string, path: string, body?: unknown, token?: string): Promise<T> {
    const headers: Record<string, string> = {
        "Authorization": authorization(token),
        "X-Emby-Authorization": authorization(token),
        "Accept": "application/json",
    };
    if (body !== undefined) headers["Content-Type"] = "application/json";
    const res = await fetch(server + path, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        timeoutMs: 20000,
        maxBytes: 4 * 1024 * 1024,
    });
    if (!res.ok) throw new ServerError(`${method} ${path.split("?")[0]}: ${res.status} ${res.statusText}`, res.status);
    const text = await res.text();
    return (text ? JSON.parse(text) : undefined) as T;
}

/** An authenticated call with the saved session. */
export function call<T>(method: string, path: string, body?: unknown): Promise<T> {
    if (!session) return Promise.reject(new Error("not signed in"));
    return request<T>(session.server, method, path, body, session.token);
}

// ---------------------------------------------------------------- the server

export function normalizeServer(s: string): string {
    s = s.trim().replace(/\/+$/, "");
    if (!/^[a-z]+:\/\//i.test(s)) s = "http://" + s;
    return s;
}

export async function publicInfo(server: string): Promise<{ ServerName: string; Version: string }> {
    return request(server, "GET", "/System/Info/Public");
}

// ---------------------------------------------------------------- Quick Connect

export async function quickConnectEnabled(server: string): Promise<boolean> {
    return (await request<boolean>(server, "GET", "/QuickConnect/Enabled")) === true;
}

export async function quickConnectStart(server: string): Promise<{ Secret: string; Code: string }> {
    try {
        return await request(server, "POST", "/QuickConnect/Initiate"); // 10.9 and later
    } catch (e) {
        if (e instanceof ServerError && (e.status === 404 || e.status === 405))
            return request(server, "GET", "/QuickConnect/Initiate"); // 10.8
        throw e;
    }
}

export async function quickConnectState(server: string, secret: string): Promise<boolean> {
    const r = await request<{ Authenticated: boolean }>(server, "GET", "/QuickConnect/Connect?Secret=" + encodeURIComponent(secret));
    return r.Authenticated;
}

export async function quickConnectFinish(server: string, secret: string, serverName: string): Promise<Session> {
    const r = await request<{ AccessToken: string; User: { Id: string; Name: string } }>(
        server, "POST", "/Users/AuthenticateWithQuickConnect", { Secret: secret });
    return { server, serverName, userId: r.User.Id, userName: r.User.Name, token: r.AccessToken };
}

export async function signOut(): Promise<void> {
    try {
        await call("POST", "/Sessions/Logout");
    } catch {
        // the token is forgotten anyway
    }
    saveSession(null);
}

// ---------------------------------------------------------------- the library

const FIELDS = "Fields=PrimaryImageAspectRatio,DateCreated,SortName&EnableUserData=true&EnableImageTypes=Primary&ImageTypeLimit=1";

function uid(): string {
    return session ? session.userId : "";
}

// ---------------------------------------------------------------- the music libraries chosen

export interface Library {
    Id: string;
    Name: string;
}

/** The server's music libraries. */
export async function musicLibraries(): Promise<Library[]> {
    const r = await call<{ Items: (Library & { CollectionType?: string })[] }>("GET", `/Users/${uid()}/Views`);
    return (r.Items ?? []).filter(v => v.CollectionType === "music");
}

/** The libraries the app shows ([]: every music library). */
export function chosenLibraries(): string[] {
    try {
        return JSON.parse(localStorage.getItem("jf.libs") ?? "[]") as string[];
    } catch {
        return [];
    }
}

export function chooseLibraries(ids: string[]): void {
    localStorage.setItem("jf.libs", JSON.stringify(ids));
}

interface Page {
    Items: Item[];
    TotalRecordCount?: number;
}

async function page(query: string): Promise<Page> {
    const r = await call<Page>("GET", `/Users/${uid()}/Items?${query}&${FIELDS}`);
    return { Items: r.Items ?? [], TotalRecordCount: r.TotalRecordCount ?? (r.Items ?? []).length };
}

/** A query in each chosen library (or across all of them), the results put together. */
async function inLibraries(query: string): Promise<Item[]> {
    const libs = chosenLibraries();
    if (!libs.length) return (await page(query)).Items;
    const pages = await Promise.all(libs.map(id => page(`${query}&ParentId=${id}`).catch(() => ({ Items: [] } as Page))));
    return pages.flatMap(p => p.Items);
}

const byName = (a: Item, b: Item) => (a.Name < b.Name ? -1 : a.Name > b.Name ? 1 : 0);

export async function latestAlbums(limit = 12): Promise<Item[]> {
    const libs = chosenLibraries();
    const one = (parent: string) =>
        call<Item[]>("GET", `/Users/${uid()}/Items/Latest?IncludeItemTypes=MusicAlbum&Limit=${limit}${parent}&${FIELDS}`);
    if (!libs.length) return one("");
    const lists = await Promise.all(libs.map(id => one(`&ParentId=${id}`).catch(() => [] as Item[])));
    return lists.flat().sort((a, b) => (b.DateCreated ?? "").localeCompare(a.DateCreated ?? "")).slice(0, limit);
}

export async function favoriteTracks(): Promise<Item[]> {
    return (await inLibraries("Filters=IsFavorite&IncludeItemTypes=Audio&Recursive=true&SortBy=SortName&Limit=200")).sort(byName);
}

export interface Favorites {
    albums: Item[];
    artists: Item[];
    songs: Item[];
}

/** Everything marked a favourite (here or in another Jellyfin app): albums, artists and songs. */
export async function favorites(): Promise<Favorites> {
    const libs = chosenLibraries();
    const parents = libs.length ? libs.map(id => `&ParentId=${id}`) : [""];
    const [albums, artists, songs] = await Promise.all([
        inLibraries("Filters=IsFavorite&IncludeItemTypes=MusicAlbum&Recursive=true&SortBy=SortName&Limit=100"),
        // artists are not inside the library folders: /Artists, per library
        Promise.all(parents.map(p => call<{ Items?: Item[] }>("GET",
            `/Artists?UserId=${uid()}&IsFavorite=true&SortBy=SortName&Limit=100${p}&${FIELDS}`)
            .then(r => r.Items ?? [], () => [] as Item[]))).then(l => l.flat()),
        favoriteTracks(),
    ]);
    const once = (items: Item[]) => [...new Map(items.map(i => [i.Id, i])).values()].sort(byName);
    console.log(`hexamp: favourites: ${albums.length} albums, ${artists.length} artists, ${songs.length} songs`);
    return { albums: once(albums), artists: once(artists), songs };
}

export async function recentlyPlayed(limit = 30): Promise<Item[]> {
    const items = await inLibraries(`Filters=IsPlayed&IncludeItemTypes=Audio&Recursive=true&SortBy=DatePlayed&SortOrder=Descending&Limit=${limit}`);
    const played = (i: Item) => i.UserData?.LastPlayedDate ?? "";
    return items.sort((a, b) => played(b).localeCompare(played(a))).slice(0, limit);
}

/** How the albums list is sorted and filtered. */
export interface AlbumFilter {
    sort: "name" | "added" | "year";
    favourites: boolean;
    genre: string | null;
    decade: number | null; // 1990 for the 1990s
}

export const NO_FILTER: AlbumFilter = { sort: "name", favourites: false, genre: null, decade: null };

function albumQuery(f: AlbumFilter): string {
    let q = "IncludeItemTypes=MusicAlbum&Recursive=true";
    q += f.sort === "added" ? "&SortBy=DateCreated,SortName&SortOrder=Descending"
        : f.sort === "year" ? "&SortBy=ProductionYear,SortName&SortOrder=Descending"
        : "&SortBy=SortName&SortOrder=Ascending";
    if (f.favourites) q += "&Filters=IsFavorite";
    if (f.genre) q += "&Genres=" + encodeURIComponent(f.genre);
    if (f.decade) q += "&Years=" + [...Array(10).keys()].map(i => f.decade! + i).join(",");
    return q;
}

/** A list query run in each chosen library: `url(parent)` gives the URL for
 * one ("" for all of them, else "&ParentId=..."). */
type ListUrl = (parent: string) => string;

async function listPage(url: string): Promise<Page> {
    const r = await call<Page>("GET", url);
    return { Items: r.Items ?? [], TotalRecordCount: r.TotalRecordCount ?? (r.Items ?? []).length };
}

/** How many items each chosen library has (one entry, "", for all of them). */
async function countsOf(url: ListUrl): Promise<{ parent: string; n: number }[]> {
    const libs = chosenLibraries();
    const parents = libs.length ? libs.map(id => `&ParentId=${id}`) : [""];
    return Promise.all(parents.map(parent => listPage(`${url(parent)}&Limit=0`)
        .then(p => ({ parent, n: p.TotalRecordCount ?? 0 }), () => ({ parent, n: 0 }))));
}

/** Items `start`..`start + limit` (library after library when several are chosen), and how many there are. */
async function pageAcross(url: ListUrl, start: number, limit: number): Promise<{ items: Item[]; total: number }> {
    if (!chosenLibraries().length) {
        const p = await listPage(`${url("")}&StartIndex=${start}&Limit=${limit}`);
        return { items: p.Items, total: p.TotalRecordCount ?? p.Items.length };
    }
    const per = await countsOf(url);
    const total = per.reduce((a, c) => a + c.n, 0);
    const items: Item[] = [];
    let base = 0;
    for (const c of per) {
        const from = Math.max(start - base, 0), to = Math.min(start + limit - base, c.n);
        if (to > from) items.push(...(await listPage(`${url(c.parent)}&StartIndex=${from}&Limit=${to - from}`)).Items);
        base += c.n;
        if (items.length >= limit) break;
    }
    return { items, total };
}

/** Where the first item from `letter` on stands in a name-sorted list ("#": the start). */
async function indexAcross(url: ListUrl, letter: string): Promise<number> {
    if (letter === "#") return 0;
    let base = 0;
    for (const c of await countsOf(url)) {
        const before = await listPage(`${url(c.parent)}&NameLessThan=${encodeURIComponent(letter)}&Limit=0`)
            .then(p => p.TotalRecordCount ?? 0, () => 0);
        if (before < c.n) return base + before;
        base += c.n;
    }
    return Math.max(0, base - 1);
}

const albumUrl = (f: AlbumFilter): ListUrl => parent => `/Users/${uid()}/Items?${albumQuery(f)}${parent}&${FIELDS}`;

export function albums(start: number, limit: number, f: AlbumFilter = NO_FILTER): Promise<{ items: Item[]; total: number }> {
    return pageAcross(albumUrl(f), start, limit);
}

export function albumIndexOf(letter: string, f: AlbumFilter): Promise<number> {
    return indexAcross(albumUrl({ ...f, sort: "name" }), letter);
}

const artistUrl: ListUrl = parent =>
    `/Artists/AlbumArtists?UserId=${uid()}&SortBy=SortName&SortOrder=Ascending${parent}&${FIELDS}`;

/** Album artists `start`..`start + limit`, by name, and how many there are. */
export function albumArtists(start: number, limit: number): Promise<{ items: Item[]; total: number }> {
    return pageAcross(artistUrl, start, limit);
}

export function artistIndexOf(letter: string): Promise<number> {
    return indexAcross(artistUrl, letter);
}

/** An artist's albums, newest first. */
export async function artistAlbums(artistId: string): Promise<Item[]> {
    return (await page(`AlbumArtistIds=${artistId}&IncludeItemTypes=MusicAlbum&Recursive=true&SortBy=ProductionYear,SortName&SortOrder=Descending`)).Items;
}

/** Up to `limit` of an artist's songs, in random order: the songs credited
 * to them, or, when there are none (an album artist whose songs name
 * others), the songs on their albums. */
export async function artistTracks(artistId: string, limit = 100): Promise<Item[]> {
    const q = `IncludeItemTypes=Audio&Recursive=true&SortBy=Random&Limit=${limit}`;
    let items = await inLibraries(`ArtistIds=${artistId}&${q}`);
    if (!items.length) items = await inLibraries(`AlbumArtistIds=${artistId}&${q}`);
    return items.slice(0, limit);
}

/** The music genres in the chosen libraries, by name. */
export async function musicGenres(): Promise<string[]> {
    const libs = chosenLibraries();
    const ids = libs.length ? libs : [""];
    const lists = await Promise.all(ids.map(id =>
        call<{ Items: { Name: string }[] }>("GET", `/MusicGenres?UserId=${uid()}&SortBy=SortName${id ? `&ParentId=${id}` : ""}`)
            .then(r => (r.Items ?? []).map(g => g.Name), () => [] as string[])));
    return [...new Set(lists.flat())].sort((a, b) => a.localeCompare(b));
}

/** Songs by id, in the order given; ids the server does not know, and items
 * that are not songs, are left out. Asked 50 at a time (a short URL). */
export async function songsById(ids: string[]): Promise<Item[]> {
    const found = new Map<string, Item>();
    for (let i = 0; i < ids.length; i += 50) {
        const r = await call<{ Items?: Item[] }>("GET", `/Users/${uid()}/Items?Ids=${ids.slice(i, i + 50).join(",")}&${FIELDS}`);
        for (const item of r.Items ?? []) found.set(item.Id, item);
    }
    return ids.map(id => found.get(id)).filter((t): t is Item => !!t && (!t.Type || t.Type === "Audio"));
}

export async function albumTracks(albumId: string): Promise<Item[]> {
    return (await page(`ParentId=${albumId}&IncludeItemTypes=Audio&SortBy=ParentIndexNumber,IndexNumber,SortName`)).Items;
}

export async function randomTracks(limit = 50): Promise<Item[]> {
    const items = await inLibraries(`IncludeItemTypes=Audio&Recursive=true&SortBy=Random&Limit=${limit}`);
    for (let i = items.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [items[i], items[j]] = [items[j], items[i]];
    }
    return items.slice(0, limit);
}

/** Songs and albums whose name matches `term`. */
export async function search(term: string): Promise<{ albums: Item[]; songs: Item[] }> {
    const q = `searchTerm=${encodeURIComponent(term)}&Recursive=true`;
    const [albums, songs] = await Promise.all([
        inLibraries(`${q}&IncludeItemTypes=MusicAlbum&Limit=8`),
        inLibraries(`${q}&IncludeItemTypes=Audio&Limit=30`),
    ]);
    return { albums: albums.slice(0, 8), songs: songs.slice(0, 30) };
}

export async function instantMix(itemId: string, limit = 50): Promise<Item[]> {
    const r = await call<{ Items: Item[] }>("GET", `/Items/${itemId}/InstantMix?UserId=${uid()}&Limit=${limit}&${FIELDS}`);
    return r.Items ?? [];
}

/** Marks the item a favourite (or not); resolves to what the server has now. */
export async function setFavorite(itemId: string, favorite: boolean): Promise<boolean> {
    const r = await call<UserData | undefined>(favorite ? "POST" : "DELETE", `/Users/${uid()}/FavoriteItems/${itemId}`);
    return r?.IsFavorite ?? favorite;
}

const years = new Map<string, number | null>();

/** The year of an album (asked once, then remembered). */
export async function albumYear(albumId: string): Promise<number | null> {
    if (!years.has(albumId)) years.set(albumId, (await call<Item>("GET", `/Users/${uid()}/Items/${albumId}`)).ProductionYear ?? null);
    return years.get(albumId) ?? null;
}

// ---------------------------------------------------------------- images and audio

/** A JPEG of the item's (or its album's) cover, `size` pixels square, or null if it has none. */
export function imageUrl(item: Item, size: number): string | null {
    if (!session) return null;
    let id = item.Id, tag = item.ImageTags?.Primary;
    if (!tag && item.AlbumId && item.AlbumPrimaryImageTag) {
        id = item.AlbumId;
        tag = item.AlbumPrimaryImageTag;
    }
    if (!tag) return null;
    return `${session.server}/Items/${id}/Images/Primary?fillWidth=${size}&fillHeight=${size}&quality=85&format=Jpg&tag=${tag}`;
}

/** The track as MP3 at `kbps` (Jellyfin converts it), from `startSeconds`. */
export function audioUrl(itemId: string, kbps: number, startSeconds = 0): string {
    if (!session) return "";
    let url = `${session.server}/Audio/${itemId}/stream.mp3?static=false&audioCodec=mp3&audioBitRate=${kbps * 1000}` +
        `&maxAudioChannels=2&audioSampleRate=44100&deviceId=${deviceId}&api_key=${session.token}`;
    if (startSeconds > 0) url += `&startTimeTicks=${Math.floor(startSeconds * 1e7)}`;
    return url;
}

export function authHeaders(): Record<string, string> {
    return session ? { Authorization: authorization(session.token), "X-Emby-Authorization": authorization(session.token) } : {};
}

// ---------------------------------------------------------------- playback reports (what the server's "recently played" shows)

export function reportStart(itemId: string, sessionId: string): void {
    call("POST", "/Sessions/Playing", { ItemId: itemId, PlaySessionId: sessionId, PlayMethod: "Transcode", CanSeek: true })
        .catch(() => {});
}

export function reportProgress(itemId: string, sessionId: string, seconds: number, paused: boolean): void {
    call("POST", "/Sessions/Playing/Progress", {
        ItemId: itemId, PlaySessionId: sessionId, PositionTicks: Math.floor(seconds * 1e7), IsPaused: paused,
        PlayMethod: "Transcode",
    }).catch(() => {});
}

export function reportStop(itemId: string, sessionId: string, seconds: number): void {
    call("POST", "/Sessions/Playing/Stopped", { ItemId: itemId, PlaySessionId: sessionId, PositionTicks: Math.floor(seconds * 1e7) })
        .catch(() => {});
}

// ---------------------------------------------------------------- helpers

export function seconds(item: Item): number {
    return item.RunTimeTicks ? item.RunTimeTicks / 1e7 : 0;
}

export function artists(item: Item): string {
    return item.Artists?.length ? item.Artists.join(", ") : item.AlbumArtist ?? "";
}

export function clock(s: number): string {
    if (!(s >= 0) || !isFinite(s)) return "0:00";
    const m = Math.floor(s / 60), r = Math.floor(s % 60);
    return `${m}:${r < 10 ? "0" : ""}${r}`;
}
