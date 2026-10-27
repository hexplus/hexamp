// The Wi-Fi going away while signed in: a dialog over everything says so,
// the app joins the remembered connection again by itself every few
// seconds, and the music goes on from where it stopped once the network is
// back (player.ts). An access point often drops a PSP that has been quiet
// for five minutes; the PSP may rejoin it on its own first.
//
// The dialog keeps the focus to itself: ← → move between its buttons, ○
// hides it (it comes back with the next drop).

import { net } from "@pspx/native";
import { document, html, signal, type Child, type PspxElement, type PspxKeyEvent } from "@pspx/ui";
import { ACCENT_B, icon } from "./icons";
import * as player from "./player";
import { connectWifi, wifiProblem } from "./wifi";

const FIRST_TRY_MS = 3000; // the PSP rejoining by itself is quicker than a new connection
const RETRY_MS = 10000;

const lost = signal(false);
const hidden = signal(false);
const status = signal("");

let opts: { profile: () => number | null; active: () => boolean; settings: () => void };
let timer = 0;
let since = 0;
let buttons: PspxElement[] = [];
let before: PspxElement | null = null; // the focus before the dialog, given back after

/** Starts watching the connection (once, at launch). */
export function watchConnection(o: typeof opts): void {
    opts = o;
    net.on("change", s => {
        if (s === "connected") return back();
        if (opts.active()) dropped();
    });
    // the dialog's buttons only, while it is up
    document.addEventListener("keydown", (e: PspxKeyEvent) => {
        if (!shown() || !buttons.length || e.defaultPrevented) return; // (□ + ↑ ↓ is the volume)
        const at = buttons.indexOf(document.activeElement as PspxElement);
        if (e.key === "Escape") {
            e.preventDefault();
            hide();
        } else if (e.key.startsWith("Arrow")) {
            e.preventDefault();
            const step = e.key === "ArrowLeft" || e.key === "ArrowUp" ? -1 : 1;
            buttons[at < 0 ? 0 : (at + step + buttons.length) % buttons.length].focus();
        } else if (e.key === "Enter" && at < 0) {
            buttons[0].focus(); // ✕ on something under the dialog: not that
            e.preventDefault();
        }
    });
}

const shown = () => lost.peek() && !hidden.peek();

function dropped(): void {
    if (lost.peek()) return;
    console.log("hexamp: the network is gone");
    since = Date.now();
    before = document.activeElement as PspxElement | null;
    hidden.set(false);
    status.set("The music plays on from what has arrived.");
    lost.set(true);
    schedule(FIRST_TRY_MS);
}

function back(): void {
    if (!lost.peek()) return;
    clearTimeout(timer);
    console.log(`hexamp: the network is back after ${Math.round((Date.now() - since) / 1000)} s`);
    const wasShown = shown();
    lost.set(false);
    if (wasShown) restoreFocus();
    player.networkBack();
}

function hide(): void {
    hidden.set(true);
    restoreFocus();
}

function restoreFocus(): void {
    const el = before;
    before = null;
    buttons = [];
    queueMicrotask(() => {
        try {
            el?.focus();
        } catch {
            // gone with the view it was in
        }
    });
}

function schedule(ms: number): void {
    clearTimeout(timer);
    timer = setTimeout(tryAgain, ms);
}

function tryAgain(): void {
    if (!lost.peek()) return;
    const s = net.status();
    if (s === "connected") return back();
    if (s === "connecting") return schedule(RETRY_MS); // an attempt under way (after waking, say)
    const profile = opts.profile();
    if (!profile) {
        status.set("Choose a connection in Wi-Fi settings.");
        return;
    }
    status.set("Joining the Wi-Fi again…");
    connectWifi(profile).then(back, e => {
        status.set(`${wifiProblem(e)} Trying again in ${RETRY_MS / 1000} s.`);
        schedule(RETRY_MS);
    });
}

/** The dialog (rendered over everything; empty while connected). */
export function connectionDialog(): Child {
    return html`<div class="modal-wrap">${() => {
        if (!lost() || hidden()) return null;
        buttons = [];
        const keep = (el: PspxElement) => {
            buttons.push(el);
            if (buttons.length === 1) queueMicrotask(() => el.focus());
        };
        return html`<div class="modal-back"><div class="modal">
            ${icon("radio", 28, ACCENT_B)}
            <text class="modal-title">No connection</text>
            <text class="hint">The Wi-Fi went away. Hexamp is joining it again, and the music goes on from where it stopped once it is back.</text>
            <text class="hint dimmed">${status}</text>
            <div class="modal-actions">
                <div class="pill" ref=${keep} onClick=${() => { before = null; hide(); opts.settings(); }}><text>Wi-Fi settings</text></div>
                <div class="pill" ref=${keep} onClick=${hide}><text>Hide</text></div>
            </div>
        </div></div>`;
    }}</div>`;
}
