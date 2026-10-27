# Hexamp

![Hexamp](assets/icon0.png)

A PSP client for the music on a [Jellyfin](https://jellyfin.org) server, written as a PSPX app in TypeScript. It has:

- a home screen with recently added albums and favourites;
- search (songs and albums by name, typed on an on-screen letter pad: the PSP has no keyboard yet);
- favourites: albums, artists and songs (also those marked in other Jellyfin apps); mixes (shuffle everything, a mix from the song playing, recently played);
- an artist's page: their albums, and *Shuffle*, which plays up to 100 of their songs in random order;
- albums and artists, 4 to a row and 8 to a page, with an A–Z index (it marks the letter you are at) and page numbers (L and R turn the pages too); albums filter by favourites, genre and decade, and sort by name, newest or year;
- a choice of which music libraries to show (*Settings > Libraries*);
- an album's ♡ makes it a favourite (for the Favourites filter);
- a bar at the bottom with the song playing (✕ opens the player) and its own play / pause button;
- a player with the album and its year, the cover, progress and seek, previous / play / next, repeat, shuffle, favourite and the queue;
- remote control from other Jellyfin apps: next, previous, play / pause, seek, the volume, and songs sent to the PSP ([below](#remote-control)).

Lists show grey skeletons while they load. The look follows a dark phone music app: deep blue-grey surfaces, white titles, and a purple-to-pink accent.

## Controls

| Button | |
|---|---|
| D-pad, ✕, ○ | move, choose, back |
| START | the player (and back) |
| SELECT | play / pause |
| L / R | previous / next song (on albums and artists: previous / next page) |
| △ | the song playing: favourite or not (a notice says what the server saved) |
| □ + ↑ / ↓ | Hexamp's volume, in 5% steps (the level shows while it changes) |
| ← → on the progress bar | seek 10 s |
| □ on the search pad | rub out a letter |

## Signing in

The PSP has no keyboard yet, so:

1. **The server's address.** It is set on the PSP with the D-pad: ↑ ↓ change a number, L R by ten, ← → move between them, ✕ connects. The first time it comes from `assets/config.json`, and after that the PSP remembers the last one used.
2. **Quick Connect.** The PSP shows a 6-digit code. In Jellyfin (web or app, signed in as you), open the user menu, then **Quick Connect**, and enter the code; the PSP signs in by itself. Quick Connect must be on in the Dashboard (*General*). No password is stored on the PSP, only the access token.

## How songs play

Set in **Settings** (the person icon), or with `"playback"` in `assets/config.json`:

- **Streaming** (the default): Jellyfin converts the song to MP3 (128 kbps by default; *Quality* changes it) and the PSP decodes it live from the network with its own MP3 decoder. It starts at once and uses no Memory Stick space. A seek asks Jellyfin to start the song over from there.
- **Download, then play:** the MP3 goes to the Memory Stick (`ms0:/PSPX/apps/Hexamp/cache/jf/`) and plays while it arrives; the next song downloads during this one. It suits a weak Wi-Fi signal. Only the current and the next song are kept.

After the PSP sleeps, the network is off: the app reconnects, and ✕ (or SELECT) on play starts the song again from where it was.

When the Wi-Fi drops while you listen (an access point often drops a PSP that has been quiet for five minutes), a dialog says so and the app joins the connection again by itself every 10 s. The music plays on from what has arrived (up to about 45 s); if it runs out, the song waits where it stopped and goes on once the network is back. ○ hides the dialog; *Wi-Fi settings* picks another connection. After 5 minutes without a network the song pauses, so the PSP can sleep.

Covers are fetched as small JPEGs and kept in `ms0:/PSPX/apps/Hexamp/cache/art/`, at most 6 MB of them (the oldest go first, so the songs keep their room); a cover changed on the server is fetched again. *Settings > Cache* clears them and the songs. *Settings > Battery* shows the charge.

## Remote control

While Hexamp is signed in, other Jellyfin apps (the web app, a phone, a TV dashboard) list the PSP among the devices they can control, and can:

| From the other app | What Hexamp does |
|---|---|
| Next / previous | the next song; the previous one (or the start of this one after 3 s), as L and R do |
| Play/pause, pause, resume, stop | as SELECT does; resume does nothing to a song already playing |
| Seek | the song from there |
| Play now / next / last (songs sent to the PSP) | a new queue; after the song playing; at the end |
| Volume up / down, set, mute, unmute | Hexamp's own volume (□ + ↑ / ↓) |

How: Hexamp tells the server what it can do (`POST /Sessions/Capabilities/Full`), then keeps the server's WebSocket (`/socket`) open; the server sends each command down it. The socket runs on a thread of its own in the runtime; a command is acted on in the next frame, through the same functions as the buttons, and the playback reports that follow are the usual ones (Stopped for the old song, Playing for the new). Hexamp sends `KeepAlive` every 30 s (half the server's `ForceKeepAlive` of 60 s), gives up on a socket that has heard nothing for 2 minutes, and opens a dropped one again after 1, 2, 4, 8, 16, then 30 s, at once when the Wi-Fi comes back, declaring its capabilities again each time.

**What the server was measured to do** (Jellyfin **12.2.0**, from a PC, 2026-10-21; the code follows these, not the API's documentation):

- `SupportsRemoteControl` and `SupportsMediaControl` are true **only while the session's WebSocket is open**. Declaring `SupportsMediaControl: true` changes nothing by itself; `PlayableMediaTypes` and `SupportedCommands` are kept from the declaration (and its query-string form replaces both).
- The socket takes the token in the `Authorization: MediaBrowser ... DeviceId=..., Token=...` header, or `?ApiKey=`. **`?api_key=` is refused (403)**, as is no token. Hexamp uses the header, so the token is not in the URL.
- The first message is `{"MessageType":"ForceKeepAlive","Data":60}`; each `KeepAlive` is answered with a `KeepAlive`. A socket that sent nothing was still open after 4 minutes (one more `ForceKeepAlive` came at 51 s).
- Commands arrive as `{"MessageType":"Playstate","Data":{"Command":"NextTrack"}}` (Seek adds `SeekPositionTicks`), `{"MessageType":"GeneralCommand","Data":{"Name":"SetVolume","Arguments":{"Volume":"40"}}}` and `{"MessageType":"Play","Data":{"ItemIds":[...],"PlayCommand":"PlayNow"}}`, 6–95 ms after another app's request. Every message seen was under 300 bytes; Hexamp skips any over 16 kB.
- When the socket closes, the session leaves `/Sessions`, and a command to it gets 404. A socket opened again finds the same session, its capabilities kept; after a server restart they are declared again.

**Tested:**

| Where | What |
|---|---|
| Node (`npm test`) | The messages' parsing (every command, bad input), the capabilities, the socket URL, the keep-alive period and the backoff. |
| Host (`pspx-runtime/tests/host/test_jellyfin.c`, normally and under GC stress) | The built app against a pretend server that behaves as 12.2.0 was measured to: capabilities declared and the session controllable; every command; the reports after Next and Previous (Stopped, then Playing); Play now and next; the volume; the socket dropped, the server "restarted", the Wi-Fi dropped, each followed by the socket opening again and commands working. |
| PPSSPP v1.20.4, against Jellyfin 12.2.0 (2026-10-21) | Controllable 4.9 s after launch (Wi-Fi included). Play (3 songs), Next, Previous, Play/pause twice, Next, sent with an admin API key: the server's NowPlayingItem and IsPaused followed in 128–345 ms each. The server restarted: it closed the socket cleanly, answered again 3 s later, Hexamp was controllable again 0.5 s after that, and commands worked. |
| **Not tested** | Anything on a PSP-1000. In PPSSPP: the music going on through a server restart (nothing was playing at that moment), and the Wi-Fi dropping (the emulator cannot drop it; the host test does). |

In PPSSPP, many of the server's MP3 transcodes failed to decode ("not an MP3 the decoder can play", firmware error 807f00fd, after 14,912 bytes); some decoded when tried again. That is the emulator's MP3 decoder and Jellyfin's stream, not remote control, and it is still to be looked into on a PSP-1000.

## `assets/config.json`

```json
{
    "server": "http://192.168.1.10:8096",
    "playback": "stream",
    "bitrate": 128,
    "profile": 1
}
```

- `server`: the address the first time (plain `http:`: PSPX has no TLS yet, so reach Jellyfin on your network, not through an https proxy).
- `playback`: `"stream"` or `"download"`.
- `bitrate`: MP3 kbps (96, 128, 192 or 256).
- `profile` (optional): a stored connection from *Settings > Network Settings*, joined without the network dialog.

## Commands

```sh
npm install
npm run build           # into dist/: EBOOT.PBP, app.js, assets/
npm run psp             # build and run in PPSSPP (Windows)
npm run typecheck
npm test                # the remote-control protocol, under Node
npx pspx deploy --to E:\  # copy dist/ to E:\PSP\GAME\Hexamp\
```

`assets/icon0.png` is the XMB icon and `assets/logo.png` the sign-in logo, both made from `hexamp-logo.png`.

## Layout

| Path | What |
|---|---|
| `src/app.ts` | Start-up: Wi-Fi, the session, the global buttons, the screens. |
| `src/jellyfin.ts` | The server: Quick Connect, the library, image and audio URLs, playback reports. |
| `src/player.ts` | The queue, playback (stream or download), the progress clock. |
| `src/views.ts` | The screens, with `html` templates and signals. |
| `src/login.ts` | The server address editor and Quick Connect. |
| `src/art.ts` | Covers: fetched, cached on the card, shown with `<img>`. |
| `src/connection.ts` | The Wi-Fi lost while signed in: the dialog, joining again, the music going on. |
| `src/remote.ts` | Remote control: the capabilities, the server's WebSocket, keep-alive and reconnecting, and `Controls`, the one interface a command goes through. |
| `src/remote_protocol.ts` | Remote control's pure part (what the messages mean), tested under Node by `test/remote.test.ts`. |
| `src/icons.ts` | Icons drawn on canvases (the fonts have no music symbols). |
| `src/app.css` | The styles. |

The host test `pspx-runtime/tests/host/test_jellyfin.c` runs the built app against a pretend server (`tests/host/jellyfin_mock.py`): sign-in, home, playing, the player's buttons, albums, and remote control. It saves a screenshot of each screen.

## License

Hexamp is under the MIT License; see [LICENSE](LICENSE). The rest of PSPX is under the Apache License 2.0.
