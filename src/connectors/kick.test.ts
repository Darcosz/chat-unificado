// Pruebas de la traducción de Kick. Se corren con: npm test
// Los mensajes imitan los que se capturaron del chat emergente de un directo real (Centrifugo).

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { cleanKickChannel } from "../core/config.ts";
import { buildKickFragments, parseKickFrame, translateKick } from "./kick.ts";

/** Envuelve un evento como lo manda Centrifugo: el `data` interno va como texto JSON. */
function push(channel: string, event: string, data: object): string {
  return JSON.stringify({ push: { channel, pub: { data: { event, data: JSON.stringify(data) }, tags: { event } } } });
}

const chat = {
  id: "d6ce70fb-d256-4093-8e42-51a57319cd1e",
  chatroom_id: 668,
  content: "hola [emote:37232:PeepoClap] chat",
  type: "message",
  created_at: "2026-10-30T21:57:10+00:00",
  sender: { id: 50943294, username: "becool_13", slug: "becool-13", identity: { color: "#75FD46", badges: [] } },
};

describe("parseKickFrame", () => {
  it("separa varios mensajes de un mismo frame e ignora las respuestas de control", () => {
    const frame = [
      JSON.stringify({ id: 1, connect: { client: "x", ping: 25 } }),
      JSON.stringify({ id: 2, subscribe: {} }),
      push("chatrooms.668.v2", "App\\Events\\ChatMessageEvent", chat),
      "{}",
    ].join("\n");
    const messages = parseKickFrame(frame);
    assert.equal(messages.length, 1);
    assert.equal(messages[0]!.event, "ChatMessageEvent");
    assert.equal(messages[0]!.data.sender.username, "becool_13");
  });

  it("entiende también el formato de Pusher", () => {
    const frame = JSON.stringify({ event: "App\\Events\\SubscriptionEvent", channel: "chatrooms.1.v2", data: JSON.stringify({ username: "fan", months: 3 }) });
    assert.deepEqual(parseKickFrame(frame), [{ event: "SubscriptionEvent", data: { username: "fan", months: 3 } }]);
    assert.deepEqual(parseKickFrame(JSON.stringify({ event: "pusher:connection_established", data: "{}" })), []);
  });
});

describe("translateKick", () => {
  it("traduce un mensaje con emotes", () => {
    const event = translateKick({ event: "ChatMessageEvent", data: chat }, "x");
    assert.ok(event);
    assert.equal(event.type, "chat");
    assert.equal(event.id, `kick-${chat.id}`);
    assert.deepEqual(event.user, { id: "50943294", name: "becool_13", login: "becool-13" });
    assert.equal(event.text, "hola PeepoClap chat");
    assert.deepEqual(event.fragments, [
      { type: "text", text: "hola " },
      { type: "emote", name: "PeepoClap", url: "https://files.kick.com/emotes/37232/fullsize" },
      { type: "text", text: " chat" },
    ]);
    assert.equal(event.timestamp, "2026-10-30T21:57:10.000Z");
  });

  it("traduce los Kicks con el nombre del regalo", () => {
    const event = translateKick(
      {
        event: "KicksGifted",
        data: {
          gift_transaction_id: "ce56e013",
          sender: { id: 1391819, username: "Swizzbeat", profile_picture: "https://files.kick.com/images/user/1391819/a.webp" },
          gift: { gift_id: "hell_yeah", name: "Hell Yeah", amount: 1, type: "BASIC" },
          created_at: "2026-10-30T22:02:47.481909796Z",
        },
      },
      "x",
    );
    assert.ok(event);
    assert.equal(event.type, "kicks");
    assert.equal(event.detail, "Hell Yeah");
    assert.equal(event.amount, 1);
    assert.equal(event.user.avatar, "https://files.kick.com/images/user/1391819/a.webp");
  });

  it("traduce subs, subs regaladas y hosts", () => {
    assert.equal(translateKick({ event: "SubscriptionEvent", data: { username: "fan", months: 3 } }, "1")?.amount, 3);
    const gifted = translateKick({ event: "GiftedSubscriptionsEvent", data: { gifter_username: "generoso", gifted_usernames: ["a", "b"] } }, "2");
    assert.equal(gifted?.type, "giftsub");
    assert.equal(gifted?.amount, 2);
    const host = translateKick({ event: "StreamHostEvent", data: { host_username: "amigo", number_viewers: 40 } }, "3");
    assert.equal(host?.type, "raid");
    assert.equal(host?.amount, 40);
  });

  it("distingue los eventos que no se muestran de los desconocidos", () => {
    assert.equal(translateKick({ event: "UserBannedEvent", data: {} }, "x"), null);
    assert.equal(translateKick({ event: "EventoNuevo", data: {} }, "x"), undefined);
  });
});

describe("buildKickFragments", () => {
  it("no parte los mensajes sin emotes", () => {
    assert.equal(buildKickFragments("hola"), undefined);
  });
});

describe("cleanKickChannel", () => {
  it("acepta el canal, su dirección o el usuario con guiones bajos", () => {
    assert.equal(cleanKickChannel("https://kick.com/Mi_Canal"), "mi-canal");
    assert.equal(cleanKickChannel("@westcol"), "westcol");
    assert.equal(cleanKickChannel("no válido"), "");
  });
});
