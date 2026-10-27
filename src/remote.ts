// Remote control: another Jellyfin app (a phone, a TV dashboard) can skip,
// pause and resume what the PSP plays. Hexamp tells the server what it can
// do (POST /Sessions/Capabilities/Full) and keeps the server's WebSocket
// open; the server sends each command down it.
//
// The socket runs on its own thread in the runtime (a WebSocket's messages
// arrive here, on the app's thread, once per frame), so a command is acted
// on like a button press: through Controls, which the player implements.
//
// The connection is kept up: KeepAlive at half the server's ForceKeepAlive
// period, a socket that has heard nothing for two periods is given up on,
// and a dropped one is opened again after 1, 2, 4… 30 s. While the Wi-Fi is
// down (or the PSP asleep) it waits for the network to be back.

import { app, net } from "@pspx/native";
import * as jf from "./jellyfin";
import {
    backoffMs, capabilities, keepAliveMs, KEEP_ALIVE, parseMessage, socketUrl, type Message, type PlayCommand,
} from "./remote_protocol";

/** What a remote command can do: the player's own buttons, and the volume. */
export interface Controls {
    next(): void;
    previous(): void;
    playPause(): void;
    pause(): void;
    unpause(): void;
    stop(): void;
    seek(seconds: number): void;
    /** Songs by id: instead of the queue (from `start`, `seconds` in), after
     * the song playing, or at the end. */
    play(ids: string[], how: PlayCommand, start: number, seconds: number): void;
    /** 0..100 */
    volume(): number;
    setVolume(percent: number): void;
}

// Jellyfin's messages are small; the library news it also sends can be
// large, and larger than this is skipped by the runtime, unread.
const MAX_MESSAGE = 16 * 1024;
const DEFAULT_KEEP_ALIVE_S = 60;

let controls: Controls | null = null;
let running = false;
let ws: WebSocket | null = null;
let opening = false;
let attempt = 0;
let retryTimer = 0;
let keepTimer = 0;
let period = DEFAULT_KEEP_ALIVE_S;
let lastHeard = 0;
let mutedFrom = 0; // the volume before Mute
let commands = 0;

/** Starts remote control (signed in, at start-up or after a sign-in). */
export function startRemote(c: Controls): void {
    controls = c;
    if (running) return;
    running = true;
    attempt = 0;
    void open();
}

/** Stops it (signing out). */
export function stopRemote(): void {
    running = false;
    clearTimeout(retryTimer);
    clearInterval(keepTimer);
    if (ws) ws.close(1000, "signed out");
    ws = null;
}

net.on("change", s => {
    if (s !== "connected" || !running || ws || opening) return;
    // the network is back: at once, not after the backoff
    clearTimeout(retryTimer);
    attempt = 0;
    void open();
});

app.on("exit", () => {
    running = false;
    if (ws) ws.close(1000, "exit");
});

function retry(): void {
    clearTimeout(retryTimer);
    if (!running) return;
    const ms = backoffMs(attempt++);
    console.log(`hexamp: remote: trying again in ${ms / 1000} s`);
    retryTimer = setTimeout(() => void open(), ms);
}

async function open(): Promise<void> {
    const s = jf.session;
    if (!running || ws || opening || !s) return;
    if (net.status() !== "connected") return; // net "change" opens it
    opening = true;
    try {
        // every time: a restarted server has forgotten them
        await jf.call("POST", "/Sessions/Capabilities/Full", capabilities());
    } catch (e) {
        opening = false;
        console.warn(`hexamp: remote: capabilities not taken: ${(e as Error).message}`);
        return retry();
    }
    opening = false;
    if (!running || ws || jf.session !== s) return;
    let sock: WebSocket;
    try {
        sock = new WebSocket(socketUrl(s.server), {
            headers: { Authorization: jf.authorization(s.token) },
            maxMessageBytes: MAX_MESSAGE,
            timeoutMs: 10000,
        });
    } catch (e) {
        console.warn(`hexamp: remote: no socket: ${(e as Error).message}`);
        return retry();
    }
    ws = sock;
    sock.onopen = () => {
        console.log("hexamp: remote: listening");
        attempt = 0;
        lastHeard = Date.now();
        schedule(DEFAULT_KEEP_ALIVE_S);
    };
    sock.onmessage = e => {
        if (typeof e.data === "string") onMessage(sock, e.data);
    };
    sock.onerror = e => console.warn(`hexamp: remote: ${e.message} (${e.code})`);
    sock.onclose = e => {
        if (ws !== sock) return;
        ws = null;
        clearInterval(keepTimer);
        console.log(`hexamp: remote: closed (${e.code}${e.reason ? " " + e.reason : ""})`);
        retry();
    };
}

/** KeepAlive every half period; a socket silent for two periods is dead
 * (the Wi-Fi went without a word), and is closed to be opened again. */
function schedule(seconds: number): void {
    period = seconds;
    clearInterval(keepTimer);
    keepTimer = setInterval(() => {
        const sock = ws;
        if (!sock || sock.readyState !== WebSocket.OPEN) return;
        if (Date.now() - lastHeard > 2 * period * 1000) {
            console.warn(`hexamp: remote: nothing from the server for ${Math.round((Date.now() - lastHeard) / 1000)} s`);
            sock.close(4000, "silent");
            return;
        }
        try {
            sock.send(KEEP_ALIVE);
        } catch {
            // the send buffer is full: the socket is stuck, and the silence check will see it
        }
    }, keepAliveMs(seconds));
}

function onMessage(sock: WebSocket, text: string): void {
    const m = parseMessage(text);
    lastHeard = Date.now();
    switch (m.kind) {
        case "forceKeepAlive":
            schedule(m.seconds);
            sock.send(KEEP_ALIVE);
            return;
        case "playstate":
        case "general":
        case "play":
            commands++;
            console.log(`hexamp: remote: ${m.command}${m.kind === "playstate" && m.seekTicks !== null ? " " + m.seekTicks : ""}` +
                `${m.kind === "play" ? ` ${m.ids.length} songs` : ""}`);
            return act(m);
        case "invalid":
            console.warn(`hexamp: remote: a message that is not one: ${text.slice(0, 80)}`);
            return;
        default:
            return; // keepAlive and the server's news
    }
}

function act(m: Message): void {
    const c = controls;
    if (!c) return;
    if (m.kind === "playstate") {
        switch (m.command) {
            case "NextTrack": return c.next();
            case "PreviousTrack": return c.previous();
            case "PlayPause": return c.playPause();
            case "Pause": return c.pause();
            case "Unpause": return c.unpause();
            case "Stop": return c.stop();
            case "Seek": return c.seek((m.seekTicks ?? 0) / 1e7);
        }
    } else if (m.kind === "play") {
        c.play(m.ids, m.command, m.startIndex, m.startTicks / 1e7);
    } else if (m.kind === "general") {
        const v = c.volume();
        switch (m.command) {
            case "VolumeUp": return c.setVolume(Math.min(100, v + 5));
            case "VolumeDown": return c.setVolume(Math.max(0, v - 5));
            case "SetVolume": return c.setVolume(m.volume ?? v);
            case "Mute":
                if (v > 0) mutedFrom = v;
                return c.setVolume(0);
            case "Unmute": return c.setVolume(v > 0 ? v : mutedFrom || 100);
            case "ToggleMute":
                if (v > 0) {
                    mutedFrom = v;
                    return c.setVolume(0);
                }
                return c.setVolume(mutedFrom || 100);
        }
    }
}

/** For the log and the tests: is the socket open, and how many commands came. */
export function remoteState(): { open: boolean; commands: number } {
    return { open: !!ws && ws.readyState === WebSocket.OPEN, commands };
}
