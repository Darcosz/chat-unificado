// Alertas de Twitch por EventSub (WebSocket): follows, subs, subs regaladas, bits y canjes
// de puntos del canal. Se reconecta solo y traduce cada notificación al formato común.

import { EventEmitter } from "node:events";
import type { ChatEvent } from "../core/event.ts";
import type { ConnectionStatus } from "../core/protocol.ts";
import type { TwitchAuth } from "./auth.ts";

const EVENTSUB_URL = "wss://eventsub.wss.twitch.tv/ws";
const SUBSCRIPTIONS_URL = "https://api.twitch.tv/helix/eventsub/subscriptions";
/** Margen extra sobre el keepalive de Twitch antes de dar la conexión por muerta. */
const KEEPALIVE_MARGIN = 5000;
const MAX_BACKOFF = 30_000;

/** Suscripciones que se crean al abrir cada sesión. */
const SUBSCRIPTIONS: { type: string; version: string; name: string; condition: (userId: string) => Record<string, string> }[] = [
  { type: "channel.follow", version: "2", name: "follows", condition: (id) => ({ broadcaster_user_id: id, moderator_user_id: id }) },
  { type: "channel.subscribe", version: "1", name: "subs", condition: (id) => ({ broadcaster_user_id: id }) },
  { type: "channel.subscription.message", version: "1", name: "resubs", condition: (id) => ({ broadcaster_user_id: id }) },
  { type: "channel.subscription.gift", version: "1", name: "subs regaladas", condition: (id) => ({ broadcaster_user_id: id }) },
  { type: "channel.cheer", version: "1", name: "bits", condition: (id) => ({ broadcaster_user_id: id }) },
  { type: "channel.channel_points_custom_reward_redemption.add", version: "1", name: "puntos", condition: (id) => ({ broadcaster_user_id: id }) },
  // Raids que llegan a tu canal. No necesita permisos extra.
  { type: "channel.raid", version: "1", name: "raids", condition: (id) => ({ to_broadcaster_user_id: id }) },
];

type EventSubEvents = {
  event: [event: ChatEvent];
  status: [status: ConnectionStatus, detail: string | undefined];
};

interface EventSubMessage {
  metadata: { message_id: string; message_type: string; message_timestamp: string; subscription_type?: string };
  payload: {
    session?: { id: string; keepalive_timeout_seconds: number | null; reconnect_url: string | null };
    subscription?: { type: string };
    event?: Record<string, unknown>;
  };
}

export class TwitchEventSub extends EventEmitter<EventSubEvents> {
  readonly #auth: TwitchAuth;
  readonly #userId: string;

  /** Conexión activa. */
  #socket: WebSocket | undefined;
  /** Conexión nueva mientras Twitch nos pide migrar (session_reconnect). */
  #migrating: WebSocket | undefined;
  #closing = false;
  #attempts = 0;
  #keepalive = 10_000;
  #watchdog: NodeJS.Timeout | undefined;
  #retryTimer: NodeJS.Timeout | undefined;
  /** Ids de mensajes ya procesados: Twitch puede repetir alguno. */
  #seen = new Set<string>();

  constructor(auth: TwitchAuth, userId: string) {
    super();
    this.#auth = auth;
    this.#userId = userId;
  }

  start(): void {
    this.#closing = false;
    this.emit("status", "connecting", undefined);
    this.#socket = this.#open(EVENTSUB_URL);
  }

  stop(): void {
    this.#closing = true;
    clearTimeout(this.#watchdog);
    clearTimeout(this.#retryTimer);
    this.#socket?.close();
    this.#migrating?.close();
    this.#socket = this.#migrating = undefined;
    this.emit("status", "disconnected", undefined);
  }

  #open(url: string): WebSocket {
    const socket = new WebSocket(url);
    socket.addEventListener("message", (message) => {
      try {
        void this.#handle(socket, JSON.parse(String(message.data)) as EventSubMessage);
      } catch (error) {
        console.error("Mensaje de EventSub no válido:", error);
      }
    });
    socket.addEventListener("close", () => {
      // Solo importa si se cerró la conexión activa sin que lo pidiéramos.
      if (socket === this.#socket && !this.#closing) {
        this.#socket = undefined;
        this.#scheduleRetry("Se perdió la conexión de alertas");
      }
    });
    return socket;
  }

  #scheduleRetry(reason: string): void {
    clearTimeout(this.#watchdog);
    clearTimeout(this.#retryTimer);
    const wait = Math.min(MAX_BACKOFF, 1000 * 2 ** this.#attempts++);
    this.emit("status", "reconnecting", reason);
    this.#retryTimer = setTimeout(() => {
      if (!this.#closing) this.#socket = this.#open(EVENTSUB_URL);
    }, wait);
  }

  /** Si Twitch no manda nada (ni keepalive) en el tiempo acordado, la conexión está muerta. */
  #resetWatchdog(): void {
    clearTimeout(this.#watchdog);
    this.#watchdog = setTimeout(() => {
      const dead = this.#socket;
      this.#socket = undefined;
      dead?.close();
      this.#scheduleRetry("Twitch dejó de responder");
    }, this.#keepalive + KEEPALIVE_MARGIN);
  }

  async #handle(socket: WebSocket, message: EventSubMessage): Promise<void> {
    if (socket === this.#socket) this.#resetWatchdog();

    switch (message.metadata.message_type) {
      case "session_welcome": {
        const session = message.payload.session!;
        this.#keepalive = (session.keepalive_timeout_seconds ?? 10) * 1000;

        if (socket === this.#migrating) {
          // Migración pedida por Twitch: las suscripciones pasan solas a la conexión nueva.
          const old = this.#socket;
          this.#socket = socket;
          this.#migrating = undefined;
          old?.close();
          this.#resetWatchdog();
          return;
        }
        if (socket !== this.#socket) return;
        this.#attempts = 0;
        this.#resetWatchdog();
        await this.#subscribe(session.id);
        return;
      }
      case "session_reconnect": {
        const url = message.payload.session?.reconnect_url;
        if (url && socket === this.#socket) this.#migrating = this.#open(url);
        return;
      }
      case "notification": {
        if (this.#seen.has(message.metadata.message_id)) return;
        this.#seen.add(message.metadata.message_id);
        if (this.#seen.size > 500) this.#seen.delete(this.#seen.values().next().value!);

        const event = translate(message);
        if (event) this.emit("event", event);
        return;
      }
      case "revocation":
        this.emit("status", "error", `Twitch revocó el permiso de ${message.payload.subscription?.type ?? "una alerta"}`);
        return;
      // session_keepalive: basta con haber reiniciado el watchdog.
    }
  }

  /** Crea las suscripciones en la sesión nueva. Twitch da 10 segundos para hacerlo. */
  async #subscribe(sessionId: string): Promise<void> {
    const failed: string[] = [];
    await Promise.all(
      SUBSCRIPTIONS.map(async (subscription) => {
        try {
          await this.#createSubscription(sessionId, subscription.type, subscription.version, subscription.condition(this.#userId));
        } catch (error) {
          console.error(`No se pudo suscribir a ${subscription.type}:`, error instanceof Error ? error.message : error);
          failed.push(subscription.name);
        }
      }),
    );
    if (this.#closing) return;

    if (failed.length === SUBSCRIPTIONS.length) this.emit("status", "error", "No se pudo activar ninguna alerta");
    else this.emit("status", "connected", failed.length ? `Sin alertas de: ${failed.join(", ")}` : undefined);
  }

  async #createSubscription(sessionId: string, type: string, version: string, condition: Record<string, string>, retry = true): Promise<void> {
    const response = await fetch(SUBSCRIPTIONS_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${await this.#auth.getAccessToken()}`,
        "Client-Id": this.#auth.clientId!,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ type, version, condition, transport: { method: "websocket", session_id: sessionId } }),
    });
    // 409: ya existía. Cuenta como éxito.
    if (response.ok || response.status === 409) return;
    if (response.status === 401 && retry) {
      await this.#auth.refresh();
      return this.#createSubscription(sessionId, type, version, condition, false);
    }
    throw new Error(`HTTP ${response.status}: ${await response.text()}`);
  }
}

// ---------- Traducción al formato común ----------

function tierText(tier: unknown): string | undefined {
  const level = Number(tier) / 1000;
  return Number.isInteger(level) && level > 0 ? `Nivel ${level}` : undefined;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function translate(message: EventSubMessage): ChatEvent | undefined {
  const e = message.payload.event ?? {};
  const anonymous = e.is_anonymous === true || typeof e.user_name !== "string";
  const base = (type: ChatEvent["type"]): ChatEvent => ({
    id: message.metadata.message_id,
    platform: "twitch",
    type,
    user: anonymous ? { id: "", name: "Anónimo" } : { id: String(e.user_id ?? ""), name: String(e.user_name) },
    flags: { firstTime: false, question: false },
    timestamp: message.metadata.message_timestamp,
  });

  switch (message.payload.subscription?.type ?? message.metadata.subscription_type) {
    case "channel.follow":
      return base("follow");

    case "channel.subscribe": {
      // Las subs regaladas llegan también como channel.subscription.gift (del que regala);
      // se muestra solo esa para no llenar el panel con una alerta por cada sub.
      if (e.is_gift === true) return undefined;
      const event = base("sub");
      event.amount = 1;
      event.detail = tierText(e.tier);
      return event;
    }

    case "channel.subscription.message": {
      const event = base("sub");
      event.amount = Number(e.cumulative_months) || 1;
      event.detail = tierText(e.tier);
      event.text = text((e.message as { text?: unknown } | undefined)?.text);
      return event;
    }

    case "channel.subscription.gift": {
      const event = base("giftsub");
      event.amount = Number(e.total) || 1;
      event.detail = tierText(e.tier);
      return event;
    }

    case "channel.cheer": {
      const event = base("bits");
      event.amount = Number(e.bits) || 0;
      event.text = text(e.message);
      return event;
    }

    case "channel.channel_points_custom_reward_redemption.add": {
      const reward = (e.reward ?? {}) as { title?: unknown; cost?: unknown };
      const event = base("reward");
      event.detail = text(reward.title);
      event.amount = Number(reward.cost) || 0;
      event.text = text(e.user_input);
      return event;
    }

    case "channel.raid": {
      // En los raids el usuario es el canal que manda la raid, no viene en user_name.
      const event = base("raid");
      event.user = { id: String(e.from_broadcaster_user_id ?? ""), name: String(e.from_broadcaster_user_name ?? "Un canal") };
      event.amount = Number(e.viewers) || 0;
      return event;
    }

    default:
      return undefined;
  }
}
