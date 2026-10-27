// Hexamp: the music on a Jellyfin server, on a PSP.
//
//   D-pad, ✕, ○   move, choose, go back          START  the player (and back)
//   SELECT        play / pause                   L / R  previous / next song
//   △             the song playing: a favourite (or not)
//   □ + ↑ / ↓     Hexamp's volume
//
// assets/config.json gives the server's address the first time (it can be
// changed on the PSP), and whether songs stream (the default) or download.

import { app, audio, fs, input } from "@pspx/native";
import { document, effect, html, render, signal, type PspxCanvasElement, type PspxKeyEvent } from "@pspx/ui";
import { connectionDialog, watchConnection } from "./connection";
import { drawVolume, icon } from "./icons";
import * as jf from "./jellyfin";
import { login } from "./login";
import * as player from "./player";
import { startRemote, stopRemote } from "./remote";
import * as views from "./views";
import { shell, toggleFavorite, togglePlayer } from "./views";
import { connectWifi, savedConnection, wifiPage, wifiProblem } from "./wifi";

interface Config {
    server?: string;
    playback?: player.Mode;
    bitrate?: number;
    /** A stored Wi-Fi connection (Settings > Network Settings) to use instead of the dialog. */
    profile?: number;
}

type Screen = "connecting" | "wifi" | "login" | "main" | "offline";
const screen = signal<Screen>("connecting");
const wifiMessage = signal("Connecting to Wi-Fi…");
const wifiReason = signal<string | null>(null);

async function readConfig(): Promise<Config> {
    try {
        return JSON.parse(await fs.readText("assets/config.json")) as Config;
    } catch {
        return {};
    }
}

const config = await readConfig();
if (config.playback && !localStorage.getItem("jf.mode")) player.setMode(config.playback);
if (config.bitrate && !localStorage.getItem("jf.kbps")) player.setBitrate(config.bitrate);

// the connection remembered from last time, joined without asking; the
// first time (or when it fails) the Wi-Fi page chooses one
async function connect(): Promise<void> {
    const profile = savedConnection(config.profile);
    screen.set("connecting");
    wifiMessage.set(profile ? "Connecting to Wi-Fi…" : "Choose a connection in the network dialog…");
    try {
        await connectWifi(profile);
    } catch (e) {
        wifiReason.set(wifiProblem(e));
        screen.set("wifi");
        return;
    }
    await signedIn();
}

async function signedIn(): Promise<void> {
    if (!jf.session) return screen.set("login");
    try {
        await jf.call("GET", `/Users/${jf.session.userId}`); // is the token still good?
        screen.set("main");
    } catch (e) {
        if (e instanceof jf.ServerError && e.status === 401) {
            jf.saveSession(null);
            return screen.set("login");
        }
        wifiMessage.set(`Jellyfin did not answer at ${jf.session.server}: ${(e as Error).message}`);
        screen.set("offline");
    }
}

// the buttons that work everywhere once signed in
const signed = () => screen.peek() === "main";
input.on("start", () => signed() && togglePlayer());
input.on("select", () => signed() && player.toggle());
// L and R: the page, where there are pages (the albums); else the song
input.on("l", () => signed() && (views.pager ? views.pager(-1) : player.previous()));
input.on("r", () => signed() && (views.pager ? views.pager(1) : player.next()));
input.on("triangle", () => {
    const t = player.current.peek();
    if (signed() && t) toggleFavorite(t);
});

// after sleep the network is off: connect again (the music waits for play)
app.on("resume", () => {
    const profile = savedConnection(config.profile);
    if (profile) connectWifi(profile).catch(() => {}); // the dialog would take the screen: only a known connection
});

player.start();

// Hexamp's own volume (the PSP's VOL buttons belong to the firmware): hold
// □ and press ↑ or ↓, in steps of 5%. The level shows each time, even when
// it is already at 0% or 100%.
const VOLUME_KEY = "hx.volume";
const volume = signal(Math.max(0, Math.min(100, Number(localStorage.getItem(VOLUME_KEY) ?? 100))));
const volumeShown = signal(false);
let volumeTimer = 0;
audio.setMasterVolume(volume.peek() / 100);

function changeVolume(step: number): void {
    setVolume(volume.peek() + step);
}

function setVolume(level: number): void {
    const v = Math.max(0, Math.min(100, Math.round(level)));
    volume.set(v);
    audio.setMasterVolume(v / 100);
    localStorage.setItem(VOLUME_KEY, String(v));
    volumeShown.set(true);
    clearTimeout(volumeTimer);
    volumeTimer = setTimeout(() => volumeShown.set(false), 1500);
}

// ↑ ↓ with □ held: the volume, not the focus (a prevented keydown does not move it)
document.addEventListener("keydown", (e: PspxKeyEvent) => {
    if (!input.state().square || (e.key !== "ArrowUp" && e.key !== "ArrowDown")) return;
    e.preventDefault();
    changeVolume(e.key === "ArrowUp" ? 5 : -5);
});

// the Wi-Fi dropping while signed in: a dialog, the connection joined
// again, and the music on from where it stopped (after the volume's keydown
// listener: □ + ↑ ↓ stays the volume while the dialog is up)
watchConnection({
    profile: () => savedConnection(config.profile),
    active: signed,
    settings: () => views.go({ name: "wifi" }),
});

// remote control (remote.ts): while signed in, another Jellyfin app can
// press the player's buttons and set the volume
effect(() => {
    const s = screen();
    if (s === "main")
        startRemote({
            next: player.next,
            previous: player.previous,
            playPause: player.toggle,
            pause: player.pause,
            unpause: player.resume,
            stop: player.stop,
            seek: player.seek,
            play: (ids, how, start, seconds) =>
                void player.playIds(ids, how, start, seconds).catch(e => console.warn(`hexamp: remote: play: ${(e as Error).message}`)),
            volume: () => volume.peek(),
            setVolume,
        });
    else if (s === "login") stopRemote(); // signed out, or another server
});

function volumeOverlay() {
    let bar: PspxCanvasElement | null = null;
    return html`<div class="volume-wrap">${() => {
        if (!volumeShown()) return null;
        return html`<div class="volume">
            ${icon("music", 14, "#ffffff")}
            <canvas class="volbar" width="120" height="8" ref=${(el: PspxCanvasElement) => { bar = el; drawVolume(el, volume.peek() / 100); }}></canvas>
            ${() => { const v = volume(); if (bar) drawVolume(bar, v / 100); return ""; }}
            <text class="volpct">${() => `${volume()}%`}</text>
        </div>`;
    }}</div>`;
}

render(() => html`<screen class="app">
    ${() => {
        switch (screen()) {
            case "connecting":
                return html`<div class="login"><img class="logo" src="assets/logo.png" /><text class="hint">${wifiMessage}</text></div>`;
            case "wifi":
                return html`<div class="page">${wifiPage(wifiReason.peek(), () => void signedIn())}</div>`;
            case "offline":
                return html`<div class="login">
                    <img class="logo" src="assets/logo.png" />
                    <text class="hint error">${wifiMessage}</text>
                    <div class="pill wide" autofocus onClick=${() => void connect()}><text>Try again</text></div>
                    <div class="pill wide" onClick=${() => { wifiReason.set(null); screen.set("wifi"); }}><text>Wi-Fi settings</text></div>
                    <div class="pill wide" onClick=${() => { jf.saveSession(null); screen.set("login"); }}><text>Another server</text></div>
                </div>`;
            case "login":
                return login(config.server ?? "", () => screen.set("main"));
            case "main":
                return shell(() => screen.set("login"));
        }
    }}
    ${views.noticeOverlay()}
    ${connectionDialog()}
    ${volumeOverlay()}
</screen>`);

await connect();
