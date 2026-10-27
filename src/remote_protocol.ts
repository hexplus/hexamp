// Jellyfin's remote control, the part with no PSP in it: what Hexamp tells
// the server it can do, and what the server's socket messages mean. It
// imports nothing, so `npm test` checks it under Node (test/remote.test.ts);
// remote.ts is the part that talks to the server.

/** The playstate commands Hexamp acts on (Jellyfin's PlaystateCommand). */
export const PLAYSTATE = ["NextTrack", "PreviousTrack", "PlayPause", "Pause", "Unpause", "Stop", "Seek"] as const;
export type Playstate = (typeof PLAYSTATE)[number];

/** The general commands Hexamp honours: its own volume. */
export const GENERAL = ["VolumeUp", "VolumeDown", "SetVolume", "Mute", "Unmute", "ToggleMute"] as const;
export type General = (typeof GENERAL)[number];

/** The body of POST /Sessions/Capabilities/Full. Measured on Jellyfin
 * 12.2.0 (README.md, "Remote control"): the server keeps PlayableMediaTypes
 * and SupportedCommands from it, but SupportsMediaControl (and with it
 * SupportsRemoteControl) is true only while the session's WebSocket is open,
 * whatever this says. It is sent all the same, for servers that read it. */
export function capabilities(): Record<string, unknown> {
    return {
        PlayableMediaTypes: ["Audio"],
        SupportedCommands: [...GENERAL],
        SupportsMediaControl: true,
        SupportsPersistentIdentifier: true,
    };
}

/** ws://host:port/socket, from the server's http:// address (no trailing
 * slash). The token goes in the Authorization header, which names the
 * device too: 12.2.0 refuses ?api_key= on the socket (403). */
export function socketUrl(server: string): string {
    return server.replace(/^http:/i, "ws:") + "/socket";
}

export const KEEP_ALIVE = '{"MessageType":"KeepAlive"}';

/** How a Play message adds songs: instead of the queue, after the song
 * playing, or at the end. */
export type PlayCommand = "PlayNow" | "PlayNext" | "PlayLast";

/** At most this many songs from one Play message (a whole library sent to
 * a PSP is refused, not fetched). */
export const PLAY_MAX = 200;

export type Message =
    | { kind: "forceKeepAlive"; seconds: number }
    | { kind: "keepAlive" }
    | { kind: "playstate"; command: Playstate; seekTicks: number | null }
    | { kind: "play"; command: PlayCommand; ids: string[]; startIndex: number; startTicks: number }
    | { kind: "general"; command: General; volume: number | null }
    | { kind: "other"; type: string } // library and user-data news, commands Hexamp does not do
    | { kind: "invalid" };

function isObject(v: unknown): v is Record<string, unknown> {
    return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** What one message from the server's socket says. Never throws: the
 * server's text is not trusted to be what it should. */
export function parseMessage(text: string): Message {
    let m: unknown;
    try {
        m = JSON.parse(text);
    } catch {
        return { kind: "invalid" };
    }
    if (!isObject(m) || typeof m.MessageType !== "string") return { kind: "invalid" };
    const type = m.MessageType, data = m.Data;
    switch (type) {
        case "ForceKeepAlive": {
            const s = Number(data);
            return Number.isFinite(s) && s > 0 ? { kind: "forceKeepAlive", seconds: s } : { kind: "invalid" };
        }
        case "KeepAlive":
            return { kind: "keepAlive" };
        case "Playstate": {
            if (!isObject(data) || typeof data.Command !== "string") return { kind: "invalid" };
            const command = PLAYSTATE.find(c => c === data.Command);
            if (!command) return { kind: "other", type: `Playstate ${data.Command}` };
            const t = data.SeekPositionTicks;
            const seekTicks = typeof t === "number" && Number.isFinite(t) && t >= 0 ? t : null;
            if (command === "Seek" && seekTicks === null) return { kind: "invalid" };
            return { kind: "playstate", command, seekTicks };
        }
        case "Play": {
            if (!isObject(data) || !Array.isArray(data.ItemIds)) return { kind: "invalid" };
            const command = data.PlayCommand;
            if (command !== "PlayNow" && command !== "PlayNext" && command !== "PlayLast")
                return { kind: "other", type: `Play ${String(command)}` };
            const ids = data.ItemIds;
            if (!ids.length || ids.length > PLAY_MAX || !ids.every(id => typeof id === "string" && /^[A-Za-z0-9-]{1,64}$/.test(id)))
                return { kind: "invalid" };
            const index = Number(data.StartIndex ?? 0), ticks = Number(data.StartPositionTicks ?? 0);
            return {
                kind: "play", command, ids: ids as string[],
                startIndex: Number.isInteger(index) && index >= 0 && index < ids.length ? index : 0,
                startTicks: Number.isFinite(ticks) && ticks > 0 ? ticks : 0,
            };
        }
        case "GeneralCommand": {
            if (!isObject(data) || typeof data.Name !== "string") return { kind: "invalid" };
            const command = GENERAL.find(c => c === data.Name);
            if (!command) return { kind: "other", type: `GeneralCommand ${data.Name}` };
            let volume: number | null = null;
            if (command === "SetVolume") {
                const args = isObject(data.Arguments) ? data.Arguments : {};
                volume = Number(args.Volume);
                if (!Number.isFinite(volume)) return { kind: "invalid" };
                volume = Math.max(0, Math.min(100, Math.round(volume)));
            }
            return { kind: "general", command, volume };
        }
        default:
            return { kind: "other", type };
    }
}

/** How often to send KeepAlive for the server's ForceKeepAlive period:
 * half of it, as Jellyfin's own clients do, within 5..60 s. */
export function keepAliveMs(seconds: number): number {
    return Math.max(5000, Math.min(60000, Math.round(seconds * 500)));
}

/** The wait before reconnect number `attempt` (0 first): 1, 2, 4, 8, 16, then 30 s. */
export function backoffMs(attempt: number): number {
    return Math.min(30000, 1000 * 2 ** Math.max(0, Math.min(attempt, 5)));
}
