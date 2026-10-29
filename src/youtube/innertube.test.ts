// Pruebas de la traducción de InnerTube. Se corren con: npm test
// Los objetos imitan las respuestas reales de get_live_chat (solo los campos que se usan).

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { amountMicros, translateAction } from "./innertube.ts";

const author = {
  authorName: { simpleText: "@viewer" },
  authorExternalChannelId: "UC123",
  authorPhoto: { thumbnails: [{ url: "https://yt3.ggpht.com/a=s32" }, { url: "https://yt3.ggpht.com/a=s64" }] },
  timestampUsec: "1793235694568363",
  id: "abc",
};

describe("translateAction", () => {
  it("traduce un mensaje con emojis", () => {
    const item = translateAction({
      addChatItemAction: {
        item: {
          liveChatTextMessageRenderer: {
            ...author,
            message: { runs: [{ text: "hola " }, { emoji: { emojiId: "🐀" } }, { text: " " }, { emoji: { isCustomEmoji: true, shortcuts: [":yt:"], image: { thumbnails: [{ url: "https://yt3.ggpht.com/e" }] } } }] },
          },
        },
      },
    });
    assert.equal(item?.snippet?.type, "TEXT_MESSAGE_EVENT");
    assert.equal(item?.snippet?.textMessageDetails?.messageText, "hola 🐀 :yt:");
    assert.equal(item?.authorDetails?.displayName, "@viewer");
    assert.equal(item?.authorDetails?.channelId, "UC123");
    assert.equal(item?.authorDetails?.profileImageUrl, "https://yt3.ggpht.com/a=s64");
    assert.equal(item?.snippet?.publishedAt, new Date(1793235694568).toISOString());
    assert.deepEqual(item?.fragments?.at(-1), { type: "emote", name: ":yt:", url: "https://yt3.ggpht.com/e" });
  });

  it("no pone fragmentos si solo hay emojis normales", () => {
    const item = translateAction({ addChatItemAction: { item: { liveChatTextMessageRenderer: { ...author, message: { runs: [{ emoji: { emojiId: "🔥" } }] } } } } });
    assert.equal(item?.fragments, undefined);
    assert.equal(item?.snippet?.textMessageDetails?.messageText, "🔥");
  });

  it("traduce un Super Chat", () => {
    const item = translateAction({
      addChatItemAction: { item: { liveChatPaidMessageRenderer: { ...author, purchaseAmountText: { simpleText: "MX$100.00" }, message: { runs: [{ text: "gracias" }] } } } },
    });
    assert.equal(item?.snippet?.type, "SUPER_CHAT_EVENT");
    assert.deepEqual(item?.snippet?.superChatDetails, { amountDisplayString: "MX$100.00", userComment: "gracias", amountMicros: "100000000" });
  });

  it("distingue miembro nuevo de hito de membresía", () => {
    const nuevo = translateAction({ addChatItemAction: { item: { liveChatMembershipItemRenderer: { ...author, headerSubtext: { simpleText: "¡Te damos la bienvenida!" } } } } });
    assert.equal(nuevo?.snippet?.type, "NEW_SPONSOR_EVENT");
    const hito = translateAction({
      addChatItemAction: { item: { liveChatMembershipItemRenderer: { ...author, headerPrimaryText: { runs: [{ text: "Miembro durante " }, { text: "6" }, { text: " meses" }] }, message: { simpleText: "¡6 meses!" } } } },
    });
    assert.equal(hito?.snippet?.type, "MEMBER_MILESTONE_CHAT_EVENT");
    assert.equal(hito?.snippet?.memberMilestoneChatDetails?.memberMonth, 6);
  });

  it("traduce membresías regaladas con el autor de la cabecera", () => {
    const item = translateAction({
      addChatItemAction: {
        item: {
          liveChatSponsorshipsGiftPurchaseAnnouncementRenderer: {
            id: "g1",
            timestampUsec: "1793235694568363",
            authorExternalChannelId: "UC9",
            header: { liveChatSponsorshipsHeaderRenderer: { authorName: { simpleText: "@generoso" }, primaryText: { runs: [{ text: "Regaló " }, { text: "5" }, { text: " membresías" }] } } },
          },
        },
      },
    });
    assert.equal(item?.snippet?.type, "MEMBERSHIP_GIFTING_EVENT");
    assert.equal(item?.snippet?.membershipGiftingDetails?.giftMembershipsCount, 5);
    assert.equal(item?.authorDetails?.displayName, "@generoso");
  });

  it("ignora lo que no se muestra", () => {
    assert.equal(translateAction({ addChatItemAction: { item: { liveChatPlaceholderItemRenderer: { id: "x" } } } }), undefined);
    assert.equal(translateAction({ markChatItemAsDeletedAction: {} }), undefined);
  });
});

describe("amountMicros", () => {
  it("entiende separadores de miles y decimales", () => {
    assert.equal(amountMicros("$1,234.50"), "1234500000");
    assert.equal(amountMicros("ARS 2.500,00"), "2500000000");
    assert.equal(amountMicros("¥500"), "500000000");
    assert.equal(amountMicros("gratis"), undefined);
  });
});
