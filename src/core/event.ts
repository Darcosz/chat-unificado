// Formato común de evento (sección 5.1 de la especificación).
// Todos los conectores traducen lo que reciben de su plataforma a este formato.

export const PLATFORMS = ["twitch", "tiktok", "youtube", "kick"] as const;
export type Platform = (typeof PLATFORMS)[number];

export type EventType =
  | "chat"
  | "follow"
  | "sub"
  | "giftsub"
  | "member"
  | "bits"
  | "superchat"
  | "kicks"
  | "gift"
  | "reward"
  | "raid"
  | "share";

export interface User {
  id: string;
  /** Nombre visible (display name en Twitch, nickname en TikTok). */
  name: string;
  /** Nombre de usuario único (login en Twitch, @usuario en TikTok), si es distinto del visible. */
  login?: string;
  avatar?: string;
}

/** Trozo de un mensaje: texto normal o un emote que se dibuja como imagen. */
export type MessageFragment = { type: "text"; text: string } | { type: "emote"; name: string; url: string };

/**
 * Por qué se resalta un mensaje de chat:
 * - bits: el mensaje vino con bits (`amount` lleva la cantidad).
 * - highlighted: alguien canjeó puntos para destacar su mensaje.
 */
export type ChatHighlight = "bits" | "highlighted";

/**
 * Uso de `detail`, `amount` y `text` en cada tipo de alerta:
 *
 * | type      | detail                  | amount            | text               |
 * |-----------|-------------------------|-------------------|--------------------|
 * | follow    | —                       | —                 | —                  |
 * | sub       | nivel ("Nivel 1")       | meses             | mensaje            |
 * | giftsub   | nivel ("Nivel 1")       | subs regaladas    | —                  |
 * | member    | nivel ("Nivel: Fan")    | meses             | mensaje            |
 * | bits      | —                       | bits              | mensaje            |
 * | superchat | monto con moneda        | monto numérico    | mensaje            |
 * | kicks     | —                       | Kicks             | mensaje            |
 * | gift      | nombre del regalo       | cantidad          | —                  |
 * | reward    | nombre de la recompensa | costo en puntos   | texto del usuario  |
 * | raid      | —                       | espectadores      | —                  |
 * | share     | "repost" si fue repost  | —                 | —                  |
 *
 * En los mensajes de chat, `amount` solo se usa con `highlight: "bits"`.
 */
export interface ChatEvent {
  id: string;
  platform: Platform;
  type: EventType;
  user: User;
  /** Mensaje de chat, o el mensaje que acompaña a una alerta. */
  text?: string;
  /** El mismo texto partido en trozos cuando lleva emotes. Si falta, se muestra `text` tal cual. */
  fragments?: MessageFragment[];
  /** Mensaje de chat resaltado (con bits o destacado con puntos). */
  highlight?: ChatHighlight;
  /** Detalle secundario de una alerta: meses, nivel, costo, nombre del regalo... */
  detail?: string;
  /** Cantidad de la alerta: bits, monto, número de regalos... */
  amount?: number;
  flags: {
    /** Primera vez que el usuario escribe en el canal. */
    firstTime: boolean;
    /** Pregunta o mención al streamer. Lo rellenan las reglas (Fase 1, paso 6). */
    question: boolean;
  };
  /** Fecha en ISO 8601 (UTC). */
  timestamp: string;
}

/** Los eventos de chat van a la columna de chat; el resto, al panel de alertas. */
export function isChat(event: ChatEvent): boolean {
  return event.type === "chat";
}
