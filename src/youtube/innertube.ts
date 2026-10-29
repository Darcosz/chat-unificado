// Lector del chat de YouTube por InnerTube: las mismas peticiones que hace la página de YouTube
// para mostrar el chat de un directo. No usa la cuota de la API ni inicia sesión (se lee como un
// espectador anónimo, así que sirve para directos públicos y sin listar, no para privados).
// No es oficial: si YouTube cambia algo puede dejar de funcionar; el conector vuelve entonces a
// la API oficial.
//
// 1. Se abre la página del chat emergente y se toman de ahí la versión del cliente web y el token
//    de continuación de la vista "Chat en vivo" (la que muestra todos los mensajes; la que viene
//    seleccionada por defecto es "Chat destacado", que filtra algunos).
// 2. Se pide get_live_chat con ese token: devuelve los mensajes nuevos, el siguiente token y
//    cuánto esperar antes de volver a preguntar.

import type { MessageFragment } from "../core/event.ts";
import type { YouTubeChatItem } from "./chat-item.ts";

const CHAT_PAGE_URL = "https://www.youtube.com/live_chat";
const GET_LIVE_CHAT_URL = "https://www.youtube.com/youtubei/v1/live_chat/get_live_chat?prettyPrint=false";
const HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36",
  "Accept-Language": "es-MX,es;q=0.9",
};
/**
 * Límites para la espera entre consultas. YouTube sugiere ~5 s (lo que usa su página para
 * espectadores anónimos), pero así el chat llegaba con 1-8 s de retraso. Como no gasta cuota,
 * se pregunta como mucho cada 2 s (unas 30 peticiones por minuto).
 */
const MIN_WAIT = 1_000;
const MAX_WAIT = 2_000;

export interface InnerTubePage {
  items: YouTubeChatItem[];
  /** Cuánto esperar antes de la siguiente consulta. */
  waitMs: number;
}

export class InnerTubeChat {
  #clientVersion = "";
  #continuation: string | undefined;

  /** Abre el chat de un video en directo. Lanza un error si la página no tiene lo esperado. */
  async start(videoId: string): Promise<void> {
    const response = await fetch(`${CHAT_PAGE_URL}?is_popout=1&v=${encodeURIComponent(videoId)}`, { headers: HEADERS });
    if (!response.ok) throw new Error(`La página del chat respondió ${response.status}`);
    const html = await response.text();

    const version = html.match(/"INNERTUBE_CONTEXT_CLIENT_VERSION":"([^"]+)"/)?.[1];
    const initialData = html.match(/(?:window\["ytInitialData"\]|var ytInitialData)\s*=\s*(\{.+?\});\s*<\/script>/s)?.[1];
    if (!version || !initialData) throw new Error("La página del chat no tiene el formato esperado");

    const renderer = (JSON.parse(initialData) as InitialData).contents?.liveChatRenderer;
    // El último elemento del selector es "Chat en vivo" (todos los mensajes).
    const views = renderer?.header?.liveChatHeaderRenderer?.viewSelector?.sortFilterSubMenuRenderer?.subMenuItems ?? [];
    const continuation =
      views.at(-1)?.continuation?.reloadContinuationData?.continuation ?? continuationOf(renderer?.continuations?.[0])?.continuation;
    if (!continuation) throw new Error("No se encontró el chat del directo");

    this.#clientVersion = version;
    this.#continuation = continuation;
  }

  /** Trae los mensajes nuevos. Lanza un error si la respuesta no trae un chat válido. */
  async next(): Promise<InnerTubePage> {
    if (!this.#continuation) throw new Error("El chat no está abierto");
    const response = await fetch(GET_LIVE_CHAT_URL, {
      method: "POST",
      headers: { ...HEADERS, "Content-Type": "application/json" },
      body: JSON.stringify({ context: { client: { clientName: "WEB", clientVersion: this.#clientVersion, hl: "es" } }, continuation: this.#continuation }),
    });
    if (!response.ok) throw new Error(`get_live_chat respondió ${response.status}`);

    const chat = ((await response.json()) as LiveChatResponse).continuationContents?.liveChatContinuation;
    const next = continuationOf(chat?.continuations?.[0]);
    // Sin continuación: el chat terminó o YouTube cambió el formato. El conector lo comprueba por la API.
    if (!chat || !next) throw new Error("El chat no devolvió continuación");

    this.#continuation = next.continuation;
    const items = (chat.actions ?? []).map(translateAction).filter((item): item is YouTubeChatItem => item !== undefined);
    return { items, waitMs: Math.min(MAX_WAIT, Math.max(MIN_WAIT, next.timeoutMs ?? 5_000)) };
  }
}

// ---------- Traducción de las acciones de InnerTube ----------

interface Run {
  text?: string;
  emoji?: { emojiId?: string; shortcuts?: string[]; isCustomEmoji?: boolean; image?: { thumbnails?: { url?: string }[] } };
}
type Text = { simpleText?: string; runs?: Run[] } | undefined;

interface Renderer {
  id?: string;
  timestampUsec?: string;
  authorName?: Text;
  authorExternalChannelId?: string;
  authorPhoto?: { thumbnails?: { url?: string }[] };
  message?: Text;
  purchaseAmountText?: Text;
  sticker?: { accessibility?: { accessibilityData?: { label?: string } } };
  headerPrimaryText?: Text;
  headerSubtext?: Text;
  header?: { liveChatSponsorshipsHeaderRenderer?: Renderer & { primaryText?: Text } };
}

/** Texto plano de un Text de YouTube; los emojis van como su carácter (o su atajo si son del canal). */
function plain(text: Text): string {
  if (!text) return "";
  if (text.simpleText !== undefined) return text.simpleText;
  return (text.runs ?? []).map((run) => run.text ?? emojiText(run.emoji)).join("");
}

function emojiText(emoji: Run["emoji"]): string {
  if (!emoji) return "";
  return emoji.isCustomEmoji ? (emoji.shortcuts?.[0] ?? "") : (emoji.emojiId ?? "");
}

/** Partes del mensaje con los emojis propios del canal como imagen. Undefined si no hay ninguno. */
function fragmentsOf(text: Text): MessageFragment[] | undefined {
  const runs = text?.runs ?? [];
  if (!runs.some((run) => run.emoji?.isCustomEmoji)) return undefined;
  return runs.map((run): MessageFragment => {
    const url = run.emoji?.image?.thumbnails?.at(-1)?.url;
    if (run.emoji?.isCustomEmoji && url?.startsWith("https://")) return { type: "emote", name: emojiText(run.emoji), url };
    return { type: "text", text: run.text ?? emojiText(run.emoji) };
  });
}

/** Primer número entero que aparezca en el texto ("Miembro durante 6 meses" → 6). */
function firstNumber(text: string): number | undefined {
  const match = text.match(/\d[\d.,]*/)?.[0];
  return match ? Number(match.replace(/[.,]/g, "")) : undefined;
}

/** "MX$1,234.50" → "1234500000" (micros, como la API oficial). */
export function amountMicros(display: string): string | undefined {
  const digits = display.replace(/[^\d.,]/g, "");
  if (!digits) return undefined;
  // El último separador seguido de 1 o 2 cifras es el decimal; los demás son de miles.
  const decimal = digits.match(/[.,](\d{1,2})$/);
  const whole = (decimal ? digits.slice(0, -decimal[0].length) : digits).replace(/[.,]/g, "");
  const value = Number(`${whole}.${decimal?.[1] ?? "0"}`);
  return Number.isFinite(value) ? String(Math.round(value * 1_000_000)) : undefined;
}

export function translateAction(action: Record<string, unknown>): YouTubeChatItem | undefined {
  const item = (action.addChatItemAction as { item?: Record<string, Renderer> } | undefined)?.item;
  if (!item) return undefined;
  const [kind, renderer] = Object.entries(item)[0] ?? [];
  if (!kind || !renderer) return undefined;

  const author = kind === "liveChatSponsorshipsGiftPurchaseAnnouncementRenderer" ? (renderer.header?.liveChatSponsorshipsHeaderRenderer ?? renderer) : renderer;
  const usec = Number(renderer.timestampUsec);
  const base: YouTubeChatItem = {
    ...(renderer.id ? { id: renderer.id } : {}),
    authorDetails: {
      channelId: renderer.authorExternalChannelId ?? author.authorExternalChannelId ?? "",
      displayName: plain(author.authorName) || "anónimo",
      ...(author.authorPhoto?.thumbnails?.at(-1)?.url ? { profileImageUrl: author.authorPhoto.thumbnails.at(-1)!.url! } : {}),
    },
  };
  const publishedAt = Number.isFinite(usec) ? new Date(usec / 1000).toISOString() : new Date().toISOString();

  switch (kind) {
    case "liveChatTextMessageRenderer": {
      const fragments = fragmentsOf(renderer.message);
      return {
        ...base,
        snippet: { type: "TEXT_MESSAGE_EVENT", publishedAt, textMessageDetails: { messageText: plain(renderer.message) } },
        ...(fragments ? { fragments } : {}),
      };
    }
    case "liveChatPaidMessageRenderer": {
      const display = plain(renderer.purchaseAmountText);
      const micros = amountMicros(display);
      return {
        ...base,
        snippet: {
          type: "SUPER_CHAT_EVENT",
          publishedAt,
          superChatDetails: { amountDisplayString: display, userComment: plain(renderer.message), ...(micros ? { amountMicros: micros } : {}) },
        },
      };
    }
    case "liveChatPaidStickerRenderer": {
      const display = plain(renderer.purchaseAmountText);
      const micros = amountMicros(display);
      const altText = renderer.sticker?.accessibility?.accessibilityData?.label;
      return {
        ...base,
        snippet: {
          type: "SUPER_STICKER_EVENT",
          publishedAt,
          superStickerDetails: { amountDisplayString: display, ...(micros ? { amountMicros: micros } : {}), ...(altText ? { superStickerMetadata: { altText } } : {}) },
        },
      };
    }
    case "liveChatMembershipItemRenderer": {
      // Con headerPrimaryText ("Miembro durante 6 meses") es un hito; sin él, un miembro nuevo.
      const months = firstNumber(plain(renderer.headerPrimaryText));
      if (renderer.headerPrimaryText && months !== undefined) {
        return {
          ...base,
          snippet: {
            type: "MEMBER_MILESTONE_CHAT_EVENT",
            publishedAt,
            memberMilestoneChatDetails: { memberMonth: months, userComment: plain(renderer.message), memberLevelName: plain(renderer.headerSubtext) },
          },
        };
      }
      return { ...base, snippet: { type: "NEW_SPONSOR_EVENT", publishedAt, newSponsorDetails: {} } };
    }
    case "liveChatSponsorshipsGiftPurchaseAnnouncementRenderer": {
      const count = firstNumber(plain(renderer.header?.liveChatSponsorshipsHeaderRenderer?.primaryText)) ?? 1;
      return { ...base, snippet: { type: "MEMBERSHIP_GIFTING_EVENT", publishedAt, membershipGiftingDetails: { giftMembershipsCount: count } } };
    }
    default:
      // Marcadores, avisos del sistema, encuestas, membresías regaladas recibidas...: no se muestran.
      return undefined;
  }
}

// ---------- Estructuras de las respuestas ----------

interface ContinuationData {
  continuation?: string;
  timeoutMs?: number;
}
type Continuation = { invalidationContinuationData?: ContinuationData; timedContinuationData?: ContinuationData; reloadContinuationData?: ContinuationData };

function continuationOf(value: Continuation | undefined): { continuation: string; timeoutMs?: number } | undefined {
  const data = value?.invalidationContinuationData ?? value?.timedContinuationData ?? value?.reloadContinuationData;
  return data?.continuation ? { continuation: data.continuation, ...(data.timeoutMs !== undefined ? { timeoutMs: data.timeoutMs } : {}) } : undefined;
}

interface InitialData {
  contents?: {
    liveChatRenderer?: {
      continuations?: Continuation[];
      header?: {
        liveChatHeaderRenderer?: {
          viewSelector?: { sortFilterSubMenuRenderer?: { subMenuItems?: { continuation?: Continuation }[] } };
        };
      };
    };
  };
}

interface LiveChatResponse {
  continuationContents?: { liveChatContinuation?: { continuations?: Continuation[]; actions?: Record<string, unknown>[] } };
}
