// Icons, drawn once on small canvases: the fonts have no music symbols.
// Each is a path in a 24-unit box, scaled to the canvas.

import { html, type PspxCanvasElement } from "@pspx/ui";

export type IconName =
    | "home" | "heart" | "heart-on" | "radio" | "albums" | "user" | "play" | "pause" | "prev" | "next"
    | "repeat" | "repeat-one" | "shuffle" | "queue" | "back" | "music" | "search" | "check" | "box" | "mic";

export const ACCENT_A = "#8b5cf6";
export const ACCENT_B = "#ec4899";

type Ctx = CanvasRenderingContext2D;

function strokeStyle(c: Ctx, color: string, w: number): void {
    c.strokeStyle = color;
    c.lineWidth = w;
    c.lineCap = "round";
    c.lineJoin = "round";
}

function heartPath(c: Ctx): void {
    c.beginPath();
    c.moveTo(12, 20);
    c.bezierCurveTo(4, 14, 2, 10.5, 2, 8);
    c.bezierCurveTo(2, 5, 4.5, 3, 7, 3);
    c.bezierCurveTo(9, 3, 11, 4.3, 12, 6);
    c.bezierCurveTo(13, 4.3, 15, 3, 17, 3);
    c.bezierCurveTo(19.5, 3, 22, 5, 22, 8);
    c.bezierCurveTo(22, 10.5, 20, 14, 12, 20);
    c.closePath();
}

function arrowHead(c: Ctx, x: number, y: number, dx: number): void {
    c.beginPath();
    c.moveTo(x - 3 * dx, y - 3);
    c.lineTo(x, y);
    c.lineTo(x - 3 * dx, y + 3);
    c.stroke();
}

/** Draws `name` in `color` over a size×size canvas. */
export function drawIcon(canvas: PspxCanvasElement, name: IconName, color: string): void {
    const c = canvas.getContext("2d");
    const s = canvas.width / 24;
    c.clearRect(0, 0, canvas.width, canvas.height);
    c.save();
    c.scale(s, s);
    c.fillStyle = color;
    strokeStyle(c, color, 2);
    switch (name) {
        case "home": // headphones
            c.beginPath();
            c.arc(12, 13, 8, Math.PI, 0);
            c.stroke();
            c.beginPath();
            c.roundRect(3, 13, 4.5, 7, 1.5);
            c.roundRect(16.5, 13, 4.5, 7, 1.5);
            c.fill();
            break;
        case "heart":
            heartPath(c);
            c.stroke();
            break;
        case "heart-on":
            heartPath(c);
            c.fill();
            break;
        case "radio":
            c.beginPath();
            c.arc(12, 12, 2.2, 0, Math.PI * 2);
            c.fill();
            for (const r of [5.5, 9]) {
                c.beginPath();
                c.arc(12, 12, r, -Math.PI * 0.3, Math.PI * 0.3);
                c.stroke();
                c.beginPath();
                c.arc(12, 12, r, Math.PI * 0.7, Math.PI * 1.3);
                c.stroke();
            }
            break;
        case "albums":
            c.beginPath();
            c.roundRect(3, 6, 14, 14, 2);
            c.stroke();
            c.beginPath();
            c.moveTo(7, 3);
            c.lineTo(19, 3);
            c.quadraticCurveTo(21, 3, 21, 5);
            c.lineTo(21, 17);
            c.stroke();
            c.beginPath();
            c.arc(10, 13, 2.2, 0, Math.PI * 2);
            c.fill();
            break;
        case "user":
            c.beginPath();
            c.arc(12, 8, 4, 0, Math.PI * 2);
            c.stroke();
            c.beginPath();
            c.arc(12, 22, 8, Math.PI * 1.15, Math.PI * 1.85);
            c.stroke();
            break;
        case "play":
            c.beginPath();
            c.moveTo(8, 5);
            c.lineTo(19, 12);
            c.lineTo(8, 19);
            c.closePath();
            c.fill();
            break;
        case "pause":
            c.fillRect(7, 5, 3.5, 14);
            c.fillRect(13.5, 5, 3.5, 14);
            break;
        case "prev":
        case "next": {
            c.save();
            if (name === "prev") {
                c.translate(24, 0);
                c.scale(-1, 1);
            }
            for (const x of [3, 11]) {
                c.beginPath();
                c.moveTo(x, 6);
                c.lineTo(x + 8, 12);
                c.lineTo(x, 18);
                c.closePath();
                c.fill();
            }
            c.fillRect(19, 6, 2, 12);
            c.restore();
            break;
        }
        case "repeat":
        case "repeat-one":
            c.beginPath();
            c.moveTo(5, 11);
            c.lineTo(5, 9);
            c.quadraticCurveTo(5, 7, 7, 7);
            c.lineTo(19, 7);
            c.stroke();
            arrowHead(c, 19, 7, 1);
            c.beginPath();
            c.moveTo(19, 13);
            c.lineTo(19, 15);
            c.quadraticCurveTo(19, 17, 17, 17);
            c.lineTo(5, 17);
            c.stroke();
            arrowHead(c, 5, 17, -1);
            if (name === "repeat-one") {
                c.font = "bold 9px sans-serif";
                c.textAlign = "center";
                c.textBaseline = "middle";
                c.fillText("1", 12, 12.5);
            }
            break;
        case "shuffle":
            c.beginPath();
            c.moveTo(3, 7);
            c.lineTo(7, 7);
            c.bezierCurveTo(12, 7, 12, 17, 17, 17);
            c.lineTo(20, 17);
            c.stroke();
            arrowHead(c, 20, 17, 1);
            c.beginPath();
            c.moveTo(3, 17);
            c.lineTo(7, 17);
            c.bezierCurveTo(12, 17, 12, 7, 17, 7);
            c.lineTo(20, 7);
            c.stroke();
            arrowHead(c, 20, 7, 1);
            break;
        case "queue":
            for (const y of [6, 12, 18]) {
                c.beginPath();
                c.moveTo(8, y);
                c.lineTo(21, y);
                c.stroke();
                c.beginPath();
                c.arc(4, y, 1.3, 0, Math.PI * 2);
                c.fill();
            }
            break;
        case "back":
            c.beginPath();
            c.moveTo(15, 5);
            c.lineTo(8, 12);
            c.lineTo(15, 19);
            c.stroke();
            break;
        case "mic":
            c.beginPath();
            c.roundRect(8.5, 2.5, 7, 12, 3.5);
            c.stroke();
            c.beginPath();
            c.arc(12, 11, 6.5, 0.1 * Math.PI, 0.9 * Math.PI);
            c.stroke();
            c.beginPath();
            c.moveTo(12, 17.5);
            c.lineTo(12, 21);
            c.moveTo(8, 21);
            c.lineTo(16, 21);
            c.stroke();
            break;
        case "search":
            c.beginPath();
            c.arc(10.5, 10.5, 6.5, 0, Math.PI * 2);
            c.stroke();
            c.lineWidth = 2.6;
            c.beginPath();
            c.moveTo(15.5, 15.5);
            c.lineTo(21, 21);
            c.stroke();
            break;
        case "box":
        case "check":
            c.beginPath();
            c.roundRect(3, 3, 18, 18, 4);
            if (name === "check") {
                c.fill();
                c.strokeStyle = "#15151d";
                c.lineWidth = 2.6;
                c.beginPath();
                c.moveTo(7, 12.5);
                c.lineTo(10.5, 16);
                c.lineTo(17, 8.5);
            }
            c.stroke();
            break;
        case "music":
            c.beginPath();
            c.moveTo(10, 17);
            c.lineTo(10, 5);
            c.lineTo(20, 3);
            c.lineTo(20, 15);
            c.stroke();
            c.beginPath();
            c.ellipse(7.5, 17.5, 3, 2.4, -0.3, 0, Math.PI * 2);
            c.ellipse(17.5, 15.5, 3, 2.4, -0.3, 0, Math.PI * 2);
            c.fill();
            break;
    }
    c.restore();
}

/** A canvas showing the icon (for one that changes, put it in a reactive hole: \${() => icon(...)}). */
export function icon(name: IconName, size = 20, color = "#e8e8f0") {
    return html`<canvas class="icon" width=${size} height=${size} ref=${(el: PspxCanvasElement) => drawIcon(el, name, color)}></canvas>`;
}

/** The volume bar: a track and the level in the accent gradient. */
export function drawVolume(canvas: PspxCanvasElement, level: number): void {
    const c = canvas.getContext("2d");
    const w = canvas.width, h = canvas.height;
    c.clearRect(0, 0, w, h);
    c.fillStyle = "#3a3a4a";
    c.beginPath();
    c.roundRect(0, 0, w, h, h / 2);
    c.fill();
    if (level > 0) {
        const g = c.createLinearGradient(0, 0, w, 0);
        g.addColorStop(0, ACCENT_A);
        g.addColorStop(1, ACCENT_B);
        c.fillStyle = g;
        c.beginPath();
        c.roundRect(0, 0, Math.max(h, w * level), h, h / 2);
        c.fill();
    }
}

/** The big round play button: the accent gradient with play or pause on it. */
export function drawPlayButton(canvas: PspxCanvasElement, isPlaying: boolean, focused: boolean): void {
    const c = canvas.getContext("2d");
    const w = canvas.width, r = w / 2;
    c.clearRect(0, 0, w, w);
    const g = c.createLinearGradient(0, 0, w, w);
    g.addColorStop(0, ACCENT_A);
    g.addColorStop(1, ACCENT_B);
    c.fillStyle = g;
    c.beginPath();
    c.arc(r, r, r - (focused ? 0.5 : 2.5), 0, Math.PI * 2);
    c.fill();
    if (focused) {
        c.strokeStyle = "rgba(255,255,255,0.85)";
        c.lineWidth = 2;
        c.beginPath();
        c.arc(r, r, r - 1.5, 0, Math.PI * 2);
        c.stroke();
    }
    c.save();
    c.translate(w * 0.25, w * 0.25);
    c.scale(w / 48, w / 48);
    c.fillStyle = "#ffffff";
    if (isPlaying) {
        c.fillRect(7, 5, 3.5, 14);
        c.fillRect(13.5, 5, 3.5, 14);
    } else {
        c.beginPath();
        c.moveTo(8.5, 5);
        c.lineTo(19, 12);
        c.lineTo(8.5, 19);
        c.closePath();
        c.fill();
    }
    c.restore();
}

/** The progress bar: a track, the played part in the accent gradient, and a knob. */
export function drawProgress(canvas: PspxCanvasElement, fraction: number, focused: boolean): void {
    const c = canvas.getContext("2d");
    const w = canvas.width, h = canvas.height, y = h / 2, x = Math.max(4, Math.min(w - 4, 4 + (w - 8) * fraction));
    c.clearRect(0, 0, w, h);
    c.fillStyle = "#3a3a4a";
    c.beginPath();
    c.roundRect(4, y - 2, w - 8, 4, 2);
    c.fill();
    const g = c.createLinearGradient(4, 0, w - 4, 0);
    g.addColorStop(0, ACCENT_A);
    g.addColorStop(1, ACCENT_B);
    c.fillStyle = g;
    c.beginPath();
    c.roundRect(4, y - 2, x - 4, 4, 2);
    c.fill();
    c.fillStyle = focused ? "#ffffff" : ACCENT_B;
    c.beginPath();
    c.arc(x, y, focused ? 5 : 4, 0, Math.PI * 2);
    c.fill();
}
