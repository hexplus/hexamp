// Wi-Fi: the first time the system's network dialog picks the connection;
// the app remembers it and joins it directly after that, without asking.
// When that fails, the Wi-Fi page lists the connections stored on the PSP
// (Settings > Network Settings) to choose again, or opens the dialog.

import { net } from "@pspx/native";
import { html, signal, type Child, type PspxElement } from "@pspx/ui";
import { ACCENT_B, icon } from "./icons";

const KEY = "jf.wifi";

/** The connection to join (remembered, else the config's), or null for the dialog. */
export function savedConnection(fallback?: number): number | null {
    const v = Number(localStorage.getItem(KEY));
    return v > 0 ? v : fallback && fallback > 0 ? fallback : null;
}

function remember(id: number | null | undefined): void {
    if (id && id > 0) localStorage.setItem(KEY, String(id));
}

export function forgetConnection(): void {
    localStorage.removeItem(KEY);
}

/** Joins `profile` directly, or through the dialog (then remembers what was chosen). */
export async function connectWifi(profile: number | null): Promise<void> {
    if (profile) {
        await net.connect({ profile, timeoutMs: 25000 });
        remember(profile);
    } else {
        await net.connect();
        remember(net.info()?.profileId);
    }
}

/** What a failed connection means, for people. */
export function wifiProblem(e: unknown): string {
    const code = (e as { code?: string })?.code;
    switch (code) {
        case "WLAN_OFF": return "The WLAN switch is off: slide it on, then try again.";
        case "CANCELLED": return "No connection was chosen.";
        case "NO_PROFILE": return "The saved connection is not on this PSP any more.";
        case "TIMEOUT":
        case "CONNECT_FAILED": return "The access point did not answer (out of range, or the password changed?).";
        case "NET_INIT": return "The PSP's network did not start. Try again.";
        default: return `Could not connect: ${(e as Error)?.message ?? e}`;
    }
}

/**
 * The Wi-Fi page: the stored connections (the one in use ticked), and the
 * dialog. `reason` says why it is shown; `onConnected` runs once joined.
 */
export function wifiPage(reason: string | null, onConnected: () => void): Child {
    const status = signal<string | null>(reason);
    const busy = signal(false);
    const current = signal(savedConnection());
    let profiles: { id: number; name: string; ssid: string }[] = [];
    try {
        profiles = net.profiles();
    } catch {
        profiles = [];
    }
    const join = (id: number | null, label: string) => {
        if (busy.peek()) return;
        busy.set(true);
        status.set(`Connecting to ${label}…`);
        const start = net.status() === "connected" ? net.disconnect().catch(() => {}) : Promise.resolve();
        start.then(() => connectWifi(id)).then(() => {
            busy.set(false);
            current.set(savedConnection());
            status.set(null);
            onConnected();
        }, e => {
            busy.set(false);
            status.set(wifiProblem(e));
        });
    };
    return html`<div class="view">
        <div class="head"><text class="title">Wi-Fi</text><text class="server">${() => (net.status() === "connected" ? net.info()?.ssid ?? "" : "not connected")}</text></div>
        ${() => {
            const s = status();
            return s ? html`<text class=${busy() ? "note" : "note error"}>${s}</text>` : "";
        }}
        <div class="list">
            ${profiles.map((p, i) => html`<div class="row" onClick=${() => join(p.id, p.name)} ref=${(el: PspxElement) => {
                if (i === 0) queueMicrotask(() => el.focus());
            }}>
                ${() => icon(current() === p.id ? "check" : "box", 18, current() === p.id ? ACCENT_B : "#8b8ba3")}
                <div class="meta"><text class="name">${p.name}</text><text class="sub">${p.ssid}</text></div>
            </div>`)}
            <div class="row" onClick=${() => join(null, "the connection you choose")} ref=${(el: PspxElement) => {
                if (!profiles.length) queueMicrotask(() => el.focus());
            }}>
                ${icon("radio", 18, "#c9b8ff")}
                <div class="meta"><text class="name">Choose in the network dialog</text><text class="sub">or set up a new connection</text></div>
            </div>
        </div>
        <text class="note">The connection chosen is remembered: the app joins it by itself next time.</text>
    </div>`;
}
