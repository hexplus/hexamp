// Signing in without a keyboard: the server's address is set with the D-pad
// (each number goes up and down), and the account is chosen on another
// device with Jellyfin's Quick Connect: the PSP shows a code, you enter it
// in Jellyfin (the user menu, Quick Connect) and the PSP is signed in.

import { html, signal, type Child, type PspxElement } from "@pspx/ui";
import * as jf from "./jellyfin";

type Step = "server" | "checking" | "code" | "error";

const IPV4 = /^(https?):\/\/(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})(?::(\d+))?$/i;

export function login(defaultServer: string, onDone: () => void): Child {
    const saved = localStorage.getItem("jf.server") ?? defaultServer;
    const m = IPV4.exec(jf.normalizeServer(saved || "http://192.168.1.10:8096"));
    // the address as numbers the D-pad edits; a name (not an IP) is kept as it is
    const parts = m ? [m[2], m[3], m[4], m[5], m[6] ?? "8096"].map(Number) : null;
    const fields = parts ? parts.map(v => signal(v)) : [];
    const fixed = parts ? null : jf.normalizeServer(saved);
    const step = signal<Step>("server");
    const message = signal("");
    const code = signal("");
    let cancelled = false;

    const address = () => (fixed ?? `http://${fields.slice(0, 4).map(f => f()).join(".")}:${fields[4]()}`);

    const field = (i: number) => {
        const max = i === 4 ? 65535 : 255;
        return html`<div class=${i === 4 ? "digit port" : "digit"} onClick=${connect} ref=${(el: PspxElement) => {
            el.addEventListener("keydown", e => {
                const f = fields[i];
                const by = e.key === "ArrowUp" ? 1 : e.key === "ArrowDown" ? -1 : e.key === "R" ? 10 : e.key === "L" ? -10 : 0;
                if (!by) return;
                f.set((f.peek() + by + max + 1) % (max + 1));
                e.preventDefault();
                e.stopPropagation();
            });
            if (i === 0) queueMicrotask(() => el.focus());
        }}><text>${() => String(fields[i]())}</text></div>`;
    };

    async function connect(): Promise<void> {7
        const server = address();
        cancelled = false;
        step.set("checking");
        message.set(`Looking for Jellyfin at ${server}…`);
        try {
            const info = await jf.publicInfo(server);
            localStorage.setItem("jf.server", server);
            if (!(await jf.quickConnectEnabled(server))) {
                step.set("error");
                message.set(`${info.ServerName} has Quick Connect turned off. Turn it on in the Dashboard (General), then try again.`);
                return;
            }
            const qc = await jf.quickConnectStart(server);
            code.set(qc.Code);
            step.set("code");
            message.set(`Signing in to ${info.ServerName}`);
            while (!cancelled) {
                await new Promise<void>(r => setTimeout(() => r(), 3000));
                if (cancelled) return;
                if (await jf.quickConnectState(server, qc.Secret)) {
                    jf.saveSession(await jf.quickConnectFinish(server, qc.Secret, info.ServerName));
                    onDone();
                    return;
                }
            }
        } catch (e) {
            if (cancelled) return;
            step.set("error");
            message.set(`Could not reach Jellyfin at ${server}: ${(e as Error).message}`);
        }
    }

    const cancel = () => {
        cancelled = true;
        step.set("server");
    };

    return html`<div class="login">
        <img class="logo" src="assets/logo.png" />
        <text class="tagline">your Jellyfin music, on the PSP</text>
        ${() => {
            switch (step()) {
                case "server":
                    return html`<div class="panel">
                        <text class="label">Server</text>
                        ${fixed
                            ? html`<text class="address">${fixed}</text>`
                            : html`<div class="ip">
                                <text class="dim">http://</text>
                                ${field(0)}<text class="dim">.</text>${field(1)}<text class="dim">.</text>
                                ${field(2)}<text class="dim">.</text>${field(3)}<text class="dim">:</text>${field(4)}
                            </div>`}
                        <text class="hint">↑ ↓ change a number (L R by ten), ← → move, ✕ connect</text>
                        <div class="pill wide" onClick=${connect} ref=${(el: PspxElement) => { if (fixed) queueMicrotask(() => el.focus()); }}><text>Connect</text></div>
                    </div>`;
                case "checking":
                    return html`<div class="panel"><text class="hint">${message}</text></div>`;
                case "code":
                    return html`<div class="panel">
                        <text class="hint">${message}</text>
                        <text class="code">${code}</text>
                        <text class="hint">In Jellyfin on your phone or PC, open the user menu, then Quick Connect, and enter this code.</text>
                        <div class="pill wide" onClick=${cancel} ref=${(el: PspxElement) => queueMicrotask(() => el.focus())}><text>Cancel</text></div>
                    </div>`;
                case "error":
                    return html`<div class="panel">
                        <text class="hint error">${message}</text>
                        <div class="pill wide" onClick=${cancel} ref=${(el: PspxElement) => queueMicrotask(() => el.focus())}><text>Back</text></div>
                    </div>`;
            }
        }}
    </div>`;
}
