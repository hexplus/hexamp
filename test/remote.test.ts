// The remote-control protocol (src/remote_protocol.ts), under Node:
//   npm test
// The messages are the shapes Jellyfin 12.2.0 was measured to send
// (README.md, "Remote control"): a Playstate's Data is { Command } (and
// SeekPositionTicks for Seek); a GeneralCommand's is { Name, ControllingUserId,
// Arguments }, its values strings.

import assert from "node:assert/strict";
import test from "node:test";
import { backoffMs, capabilities, keepAliveMs, parseMessage, socketUrl } from "../src/remote_protocol.ts";

test("capabilities: audio, media control, the volume commands", () => {
    const c = capabilities();
    assert.deepEqual(c.PlayableMediaTypes, ["Audio"]);
    assert.equal(c.SupportsMediaControl, true);
    assert.deepEqual(c.SupportedCommands, ["VolumeUp", "VolumeDown", "SetVolume", "Mute", "Unmute", "ToggleMute"]);
    JSON.parse(JSON.stringify(c)); // a plain JSON body
});

test("socketUrl: ws:, and no token in it (it goes in the header)", () => {
    assert.equal(socketUrl("http://192.168.1.10:8096"), "ws://192.168.1.10:8096/socket");
    assert.equal(socketUrl("HTTP://h"), "ws://h/socket");
});

test("playstate commands", () => {
    for (const c of ["NextTrack", "PreviousTrack", "PlayPause", "Pause", "Unpause", "Stop"])
        assert.deepEqual(parseMessage(JSON.stringify({ MessageType: "Playstate", Data: { Command: c, ControllingUserId: "u" } })),
            { kind: "playstate", command: c, seekTicks: null });
    assert.deepEqual(parseMessage('{"MessageType":"Playstate","Data":{"Command":"Seek","SeekPositionTicks":600000000}}'),
        { kind: "playstate", command: "Seek", seekTicks: 600000000 });
    assert.deepEqual(parseMessage('{"MessageType":"Playstate","Data":{"Command":"Seek"}}'), { kind: "invalid" });
    assert.deepEqual(parseMessage('{"MessageType":"Playstate","Data":{"Command":"Rewind"}}'), { kind: "other", type: "Playstate Rewind" });
    assert.deepEqual(parseMessage('{"MessageType":"Playstate","Data":{}}'), { kind: "invalid" });
    assert.deepEqual(parseMessage('{"MessageType":"Playstate","Data":{"Command":"Seek","SeekPositionTicks":-5}}'), { kind: "invalid" });
});

test("play: now, next, last; ids checked, start clamped", () => {
    assert.deepEqual(parseMessage('{"MessageType":"Play","Data":{"ItemIds":["a1","b2"],"StartPositionTicks":100000000,"PlayCommand":"PlayNow","ControllingUserId":"0"}}'),
        { kind: "play", command: "PlayNow", ids: ["a1", "b2"], startIndex: 0, startTicks: 100000000 });
    assert.deepEqual(parseMessage('{"MessageType":"Play","Data":{"ItemIds":["a1","b2"],"PlayCommand":"PlayNow","StartIndex":1}}'),
        { kind: "play", command: "PlayNow", ids: ["a1", "b2"], startIndex: 1, startTicks: 0 });
    assert.deepEqual(parseMessage('{"MessageType":"Play","Data":{"ItemIds":["a1"],"PlayCommand":"PlayNext","StartIndex":7}}'),
        { kind: "play", command: "PlayNext", ids: ["a1"], startIndex: 0, startTicks: 0 });
    assert.equal(parseMessage('{"MessageType":"Play","Data":{"ItemIds":["a1"],"PlayCommand":"PlayLast"}}').kind, "play");
    assert.deepEqual(parseMessage('{"MessageType":"Play","Data":{"ItemIds":["a1"],"PlayCommand":"PlayShuffle"}}'),
        { kind: "other", type: "Play PlayShuffle" });
    for (const ids of ['[]', '["../x"]', '[7]', JSON.stringify(Array(201).fill("a"))])
        assert.deepEqual(parseMessage(`{"MessageType":"Play","Data":{"ItemIds":${ids},"PlayCommand":"PlayNow"}}`), { kind: "invalid" }, ids);
});

test("general commands: the volume", () => {
    assert.deepEqual(parseMessage('{"MessageType":"GeneralCommand","Data":{"Name":"VolumeUp","Arguments":{}}}'),
        { kind: "general", command: "VolumeUp", volume: null });
    assert.deepEqual(parseMessage('{"MessageType":"GeneralCommand","Data":{"Name":"SetVolume","Arguments":{"Volume":"42"}}}'),
        { kind: "general", command: "SetVolume", volume: 42 });
    assert.deepEqual(parseMessage('{"MessageType":"GeneralCommand","Data":{"Name":"SetVolume","Arguments":{"Volume":"250"}}}'),
        { kind: "general", command: "SetVolume", volume: 100 });
    assert.deepEqual(parseMessage('{"MessageType":"GeneralCommand","Data":{"Name":"SetVolume","Arguments":{}}}'), { kind: "invalid" });
    assert.deepEqual(parseMessage('{"MessageType":"GeneralCommand","Data":{"Name":"DisplayMessage"}}'),
        { kind: "other", type: "GeneralCommand DisplayMessage" });
});

test("keep-alive and the server's news", () => {
    assert.deepEqual(parseMessage('{"MessageType":"ForceKeepAlive","Data":60,"MessageId":"x"}'), { kind: "forceKeepAlive", seconds: 60 });
    assert.deepEqual(parseMessage('{"MessageType":"ForceKeepAlive","Data":0}'), { kind: "invalid" });
    assert.deepEqual(parseMessage('{"MessageType":"KeepAlive","MessageId":"y"}'), { kind: "keepAlive" });
    assert.deepEqual(parseMessage('{"MessageType":"UserDataChanged","Data":{"UserId":"u"}}'), { kind: "other", type: "UserDataChanged" });
});

test("anything else is invalid, never a throw", () => {
    for (const t of ["", "not json", "null", "[]", "42", '{"Data":1}', '{"MessageType":7}', '"Playstate"'])
        assert.deepEqual(parseMessage(t), { kind: "invalid" }, t);
});

test("keep-alive period and backoff", () => {
    assert.equal(keepAliveMs(60), 30000);
    assert.equal(keepAliveMs(1), 5000);
    assert.equal(keepAliveMs(600), 60000);
    assert.deepEqual([0, 1, 2, 3, 4, 5, 6, 50].map(backoffMs), [1000, 2000, 4000, 8000, 16000, 30000, 30000, 30000]);
});
