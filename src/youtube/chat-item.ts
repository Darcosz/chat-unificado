// Forma común de un mensaje del chat de YouTube, venga del flujo gRPC, de la API REST o de
// InnerTube. Sigue los nombres de la API oficial (en camelCase), para que el conector traduzca
// todo con el mismo código.

import type { MessageFragment } from "../core/event.ts";

export interface YouTubeChatItem {
  id?: string;
  snippet?: {
    /** Tipo en mayúsculas, como en el .proto: "TEXT_MESSAGE_EVENT", "SUPER_CHAT_EVENT"... */
    type?: string;
    publishedAt?: string;
    displayMessage?: string;
    textMessageDetails?: { messageText?: string };
    superChatDetails?: { amountMicros?: string; amountDisplayString?: string; userComment?: string };
    superStickerDetails?: { amountMicros?: string; amountDisplayString?: string; superStickerMetadata?: { altText?: string } };
    newSponsorDetails?: { memberLevelName?: string; isUpgrade?: boolean };
    memberMilestoneChatDetails?: { memberLevelName?: string; memberMonth?: number; userComment?: string };
    membershipGiftingDetails?: { giftMembershipsCount?: number; giftMembershipsLevelName?: string };
    giftDetails?: { giftName?: string; comboCount?: number; jewelsAmount?: number };
  };
  authorDetails?: { channelId?: string; displayName?: string; profileImageUrl?: string };
  /** Solo InnerTube: el texto partido con los emojis personalizados del canal como imagen. */
  fragments?: MessageFragment[];
}
