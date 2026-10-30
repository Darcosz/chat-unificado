// Conector de Kick: sin login, lee el chat emergente del canal en una ventana oculta de la app
// de escritorio (ver src/kick/page.ts) y traduce lo que la página recibe por su WebSocket.
// Kick usa Centrifugo, pero dentro de cada mensaje conserva los nombres de evento de cuando
// usaba Pusher (App\Events\ChatMessageEvent...), así que se entienden los dos formatos.
//
// Comprobado con un directo real: chat (con respuestas y emotes) y Kicks. Las suscripciones,
// subs regaladas y hosts se traducen con la forma que tenían en Pusher, sin comprobar todavía;
// cualquier evento desconocido se anota una vez en la consola para poder ajustarlo.

import { Connector } from "../core/connector.ts";
import type { ChatEvent, EventType, MessageFragment, User } from "../core/event.ts";
import { kickPageOpener, type KickPage } from "../kick/page.ts";

/** Sin mensajes durante este tiempo se recarga la página (Kick manda un ping cada 25 s). */
const STALL_TIMEOUT = 90_000;
/** Tope de espera entre recargas cuando la página no responde. */
const MAX_STALL_TIMEOUT = 10 * 60_000;
const WATCHDOG_INTERVAL = 15_000;
/** Cuántos eventos recientes se recuerdan para no repetirlos (llegan por más de un canal). */
const RECENT_LIMIT = 500;

const EMOTE = /\[emote:(\d+):([^\]]*)\]/g;
const emoteUrl = (id: string) => `https://files.kick.com/emotes/${id}/fullsize`;

/** Eventos conocidos que no se muestran. */
const IGNORED = new Set([
  "UserBannedEvent",
  "UserUnbannedEvent",
  "MessageDeletedEvent",
  "ChatroomClearEvent",
  "ChatroomUpdatedEvent",
  "PinnedMessageCreatedEvent",
  "PinnedMessageDeletedEvent",
  "PollUpdateEvent",
  "PollDeleteEvent",
  "KicksLeaderboardUpdated",
  "StreamerIsLive",
  "StopStreamBroadcast",
  "LivestreamUpdated",
  "LuckyUsersWhoGotGiftSubscriptionsEvent",
]);

export interface KickMessage {
  /** Nombre del evento sin el prefijo "App\Events\". */
  event: string;
  data: Record<string, any>;
}

/** Saca los eventos de un mensaje del WebSocket (Centrifugo junta varios, uno por línea). */
export function parseKickFrame(payload: string): KickMessage[] {
  const messages: KickMessage[] = [];
  for (const line of payload.split("\n")) {
    if (!line.trim()) continue;
    let message: any;
    try {
      message = JSON.parse(line);
    } catch {
      continue;
    }
    // Centrifugo: { push: { channel, pub: { data: { event, data } } } }. Pusher: { event, data }.
    const inner = message?.push?.pub?.data ?? message;
    if (typeof inner?.event !== "string" || inner.event.startsWith("pusher")) continue;
    let data = inner.data;
    if (typeof data === "string") {
      try {
        data = JSON.parse(data);
      } catch {
        continue;
      }
    }
    if (typeof data !== "object" || data === null) continue;
    messages.push({ event: inner.event.replace(/^App\\Events\\/, ""), data });
  }
  return messages;
}

/** Parte el texto en trozos de texto y emotes ([emote:id:nombre]). */
export function buildKickFragments(content: string): MessageFragment[] | undefined {
  const fragments: MessageFragment[] = [];
  let last = 0;
  for (const match of content.matchAll(EMOTE)) {
    if (match.index > last) fragments.push({ type: "text", text: content.slice(last, match.index) });
    fragments.push({ type: "emote", name: match[2]!, url: emoteUrl(match[1]!) });
    last = match.index + match[0].length;
  }
  if (fragments.length === 0) return undefined;
  if (last < content.length) fragments.push({ type: "text", text: content.slice(last) });
  return fragments;
}

/** El mensaje con los emotes escritos por su nombre, para las reglas y la consola. */
const plainText = (content: string) => content.replace(EMOTE, (_match, _id, name: string) => name);

function userFromName(name: unknown): User | undefined {
  if (typeof name !== "string" || !name) return undefined;
  return { id: name.toLowerCase(), name };
}

function base(type: EventType, id: string, user: User, createdAt: unknown): ChatEvent {
  const date = typeof createdAt === "string" ? new Date(createdAt) : new Date();
  return {
    id: `kick-${id}`,
    platform: "kick",
    type,
    user,
    flags: { firstTime: false, question: false },
    timestamp: (Number.isNaN(date.getTime()) ? new Date() : date).toISOString(),
  };
}

/**
 * Traduce un evento de Kick al formato común. Devuelve `null` si es un evento conocido que
 * no se muestra y `undefined` si no se conoce.
 */
export function translateKick({ event, data }: KickMessage, fallbackId: string): ChatEvent | null | undefined {
  switch (event) {
    case "ChatMessageEvent": {
      const sender = data.sender;
      if (typeof data.content !== "string" || !sender?.username) return null;
      const result = base("chat", String(data.id ?? fallbackId), { id: String(sender.id ?? sender.username), name: sender.username, login: sender.slug }, data.created_at);
      result.text = plainText(data.content);
      const fragments = buildKickFragments(data.content);
      if (fragments) result.fragments = fragments;
      return result;
    }
    case "KicksGifted": {
      const sender = data.sender;
      if (!sender?.username) return null;
      const user: User = { id: String(sender.id ?? sender.username), name: sender.username };
      if (sender.profile_picture) user.avatar = sender.profile_picture;
      const result = base("kicks", String(data.gift_transaction_id ?? fallbackId), user, data.created_at);
      if (data.gift?.name) result.detail = data.gift.name;
      if (typeof data.gift?.amount === "number") result.amount = data.gift.amount;
      if (typeof data.message === "string" && data.message) result.text = data.message;
      return result;
    }
    // Sin comprobar todavía: forma que tenían en Pusher.
    case "SubscriptionEvent": {
      const user = userFromName(data.username);
      if (!user) return null;
      const result = base("sub", fallbackId, user, data.created_at);
      if (typeof data.months === "number") result.amount = data.months;
      return result;
    }
    case "GiftedSubscriptionsEvent": {
      const user = userFromName(data.gifter_username) ?? { id: "anonimo", name: "Anónimo" };
      const result = base("giftsub", fallbackId, user, data.created_at);
      result.amount = Array.isArray(data.gifted_usernames) ? data.gifted_usernames.length : 1;
      return result;
    }
    case "StreamHostEvent": {
      const user = userFromName(data.host_username);
      if (!user) return null;
      const result = base("raid", fallbackId, user, data.created_at);
      if (typeof data.number_viewers === "number") result.amount = data.number_viewers;
      if (typeof data.optional_message === "string" && data.optional_message) result.text = data.optional_message;
      return result;
    }
    case "FollowersUpdated": {
      // Solo cuenta como follow si dice quién siguió (sin sesión, Kick no suele decirlo).
      const user = userFromName(data.username);
      if (!user || data.followed === false) return null;
      return base("follow", fallbackId, user, data.created_at);
    }
  }
  return IGNORED.has(event) ? null : undefined;
}

export class KickConnector extends Connector {
  readonly platform = "kick";
  readonly channel: string;

  #page: KickPage | undefined;
  #watchdog: NodeJS.Timeout | undefined;
  #reloadTimer: NodeJS.Timeout | undefined;
  #lastActivity = 0;
  #stalls = 0;
  #everOpened = false;
  #challenge = false;
  #sequence = 0;
  readonly #recent = new Set<string>();
  readonly #reported = new Set<string>();

  constructor(channel: string) {
    super();
    this.channel = channel;
  }

  async connect(): Promise<void> {
    const open = kickPageOpener();
    if (!open) {
      this.setStatus("error", "Kick solo funciona en la app de escritorio");
      return;
    }
    this.setStatus("connecting", `Abriendo el chat de ${this.channel}`);
    this.#lastActivity = Date.now();
    this.#page = open(this.channel, {
      socketOpened: () => {
        this.#everOpened = true;
        this.#lastActivity = Date.now();
      },
      frame: (payload) => this.#onFrame(payload),
      socketClosed: () => {
        if (this.#page) this.setStatus("reconnecting", "Se cortó la conexión con Kick");
      },
      challenge: (active) => {
        this.#challenge = active;
        this.#lastActivity = Date.now();
        if (active) this.setStatus("error", "Kick pide comprobar que eres una persona: complétalo en la ventana que se abrió");
        else this.setStatus("connecting", `Abriendo el chat de ${this.channel}`);
      },
      loadFailed: (reason) => this.#onLoadFailed(reason),
    });
    this.#watchdog = setInterval(() => this.#checkStall(), WATCHDOG_INTERVAL);
  }

  async disconnect(): Promise<void> {
    clearInterval(this.#watchdog);
    clearTimeout(this.#reloadTimer);
    const page = this.#page;
    this.#page = undefined;
    page?.close();
    this.setStatus("disconnected");
  }

  #onFrame(payload: string): void {
    if (!this.#page) return;
    this.#lastActivity = Date.now();
    if (this.status !== "connected" && !this.#challenge) {
      this.#stalls = 0;
      this.setStatus("connected");
    }
    for (const message of parseKickFrame(payload)) {
      // La página escucha varios canales y un mismo evento puede llegar por más de uno.
      const key = `${message.event}:${message.data.id ?? message.data.gift_transaction_id ?? JSON.stringify(message.data)}`;
      if (this.#recent.has(key)) continue;
      this.#recent.add(key);
      if (this.#recent.size > RECENT_LIMIT) this.#recent.delete(this.#recent.values().next().value!);

      const event = translateKick(message, `${Date.now()}-${++this.#sequence}`);
      if (event) this.emit("event", event);
      else if (event === undefined && !this.#reported.has(message.event)) {
        this.#reported.add(message.event);
        console.log(`[kick] evento sin traducir: ${message.event} ${JSON.stringify(message.data).slice(0, 500)}`);
      }
    }
  }

  /** Si la página deja de recibir mensajes, se recarga; cada vez se espera un poco más. */
  #checkStall(): void {
    if (!this.#page || this.#challenge) return;
    const limit = Math.min(STALL_TIMEOUT * 2 ** this.#stalls, MAX_STALL_TIMEOUT);
    if (Date.now() - this.#lastActivity < limit) return;
    this.#stalls++;
    this.#lastActivity = Date.now();
    this.setStatus(
      "reconnecting",
      this.#everOpened ? "Kick dejó de responder; recargando el chat" : `No se pudo abrir el chat de ${this.channel}. ¿Está bien escrito el canal?`,
    );
    this.#page.reload();
  }

  #onLoadFailed(reason: string): void {
    if (!this.#page) return;
    this.#stalls++;
    const delay = Math.min(5_000 * 2 ** this.#stalls, 5 * 60_000);
    this.setStatus("reconnecting", `No se pudo abrir Kick (${reason}); se vuelve a probar en ${Math.round(delay / 1000)} s`);
    clearTimeout(this.#reloadTimer);
    this.#reloadTimer = setTimeout(() => {
      this.#lastActivity = Date.now();
      this.#page?.reload();
    }, delay);
  }
}
