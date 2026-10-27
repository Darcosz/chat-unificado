// Conector de Twitch: lee el chat por IRC con tmi.js (lectura anónima, sin token) y, si hay
// sesión iniciada, recibe las alertas por EventSub. Todo se traduce al formato común.

import { randomUUID } from "node:crypto";
import tmi from "tmi.js";
import { Connector } from "../core/connector.ts";
import type { ChatEvent, MessageFragment } from "../core/event.ts";
import type { ConnectionStatus } from "../core/protocol.ts";
import type { TwitchAuth } from "../twitch/auth.ts";
import { TwitchEventSub } from "../twitch/eventsub.ts";

export interface TwitchAlertsOptions {
  auth: TwitchAuth;
  /** Id de la cuenta con sesión iniciada: sus alertas son las que se reciben. */
  userId: string;
  /** Estado de la conexión de alertas, que se muestra aparte del chat. */
  onStatus: (status: ConnectionStatus, detail: string | undefined) => void;
}

export class TwitchConnector extends Connector {
  readonly platform = "twitch";
  readonly channel: string;

  #client: tmi.Client;
  #alerts: TwitchEventSub | undefined;
  /** true mientras cerramos a propósito, para no confundirlo con una caída. */
  #closing = false;

  constructor(channel: string, alerts?: TwitchAlertsOptions) {
    super();
    this.channel = channel.trim().replace(/^#/, "").toLowerCase();
    if (!/^[a-z0-9_]{1,25}$/.test(this.channel)) {
      throw new Error(`Nombre de canal de Twitch no válido: "${channel}"`);
    }

    // tmi.js reintenta solo, sin límite de intentos, con espera creciente.
    this.#client = new tmi.Client({
      channels: [this.channel],
      connection: { reconnect: true, secure: true },
    });

    this.#client.on("connecting", () => {
      if (this.status !== "reconnecting") this.setStatus("connecting");
    });
    this.#client.on("connected", () => this.setStatus("connected"));
    this.#client.on("disconnected", (reason) => {
      this.setStatus(this.#closing ? "disconnected" : "reconnecting", reason);
    });
    this.#client.on("reconnect", () => this.setStatus("reconnecting"));

    this.#client.on("message", (_channel, tags, message, self) => {
      if (self) return;
      // "Destacar mi mensaje" se canjea con puntos y llega como un mensaje con este msg-id.
      const highlighted = (tags as Record<string, unknown>)["msg-id"] === "highlighted-message";
      this.emit("event", translateMessage(tags, message, highlighted ? { highlight: "highlighted" } : undefined));
    });

    // Los mensajes con bits llegan por "cheer" en vez de "message". La alerta llega aparte por EventSub.
    this.#client.on("cheer", (_channel, tags, message) => {
      this.emit("event", translateMessage(tags, message, { highlight: "bits", amount: Number(tags.bits) || 0 }));
    });

    if (alerts) {
      this.#alerts = new TwitchEventSub(alerts.auth, alerts.userId);
      this.#alerts.on("event", (event) => this.emit("event", event));
      this.#alerts.on("status", alerts.onStatus);
    }
  }

  async connect(): Promise<void> {
    this.#closing = false;
    this.#alerts?.start();
    try {
      await this.#client.connect();
    } catch (error) {
      // Si falla el primer intento, tmi.js sigue reintentando por su cuenta.
      this.setStatus("error", error instanceof Error ? error.message : String(error));
    }
  }

  async disconnect(): Promise<void> {
    this.#closing = true;
    this.#alerts?.stop();
    try {
      await this.#client.disconnect();
    } catch {
      // Ya estaba desconectado.
    }
    this.setStatus("disconnected");
  }
}

function translateMessage(tags: tmi.ChatUserstate, message: string, extra?: Pick<ChatEvent, "highlight" | "amount">): ChatEvent {
  const sentAt = Number(tags["tmi-sent-ts"]);
  const fragments = buildFragments(message, tags.emotes);
  return {
    id: tags.id ?? randomUUID(),
    platform: "twitch",
    type: "chat",
    user: {
      id: tags["user-id"] ?? "",
      name: tags["display-name"] ?? tags.username ?? "anónimo",
    },
    text: message,
    ...(fragments ? { fragments } : {}),
    ...extra,
    flags: {
      // Twitch marca con first-msg el primer mensaje del usuario en el canal.
      firstTime: Boolean(tags["first-msg"]),
      question: false,
    },
    timestamp: (Number.isFinite(sentAt) ? new Date(sentAt) : new Date()).toISOString(),
  };
}

function emoteUrl(id: string): string {
  return `https://static-cdn.jtvnw.net/emoticons/v2/${id}/default/dark/2.0`;
}

/**
 * Parte el mensaje en texto y emotes según el tag `emotes` de Twitch, que da para cada
 * emote sus posiciones "inicio-fin" contadas en caracteres Unicode (no en unidades UTF-16,
 * por eso se usa Array.from: un emoji antes del emote no descuadra las posiciones).
 * Devuelve undefined si el mensaje no lleva emotes.
 */
export function buildFragments(message: string, emotes: Record<string, string[]> | null | undefined): MessageFragment[] | undefined {
  if (!emotes) return undefined;
  const chars = Array.from(message);

  const ranges: { start: number; end: number; id: string }[] = [];
  for (const [id, positions] of Object.entries(emotes)) {
    if (!/^[\w-]+$/.test(id)) continue;
    for (const position of positions) {
      const [start, end] = position.split("-").map(Number);
      if (Number.isInteger(start) && Number.isInteger(end) && start! >= 0 && end! >= start! && end! < chars.length) {
        ranges.push({ start: start!, end: end!, id });
      }
    }
  }
  if (ranges.length === 0) return undefined;
  ranges.sort((a, b) => a.start - b.start);

  const fragments: MessageFragment[] = [];
  let position = 0;
  for (const range of ranges) {
    if (range.start < position) continue; // Rango encimado con el anterior: se ignora.
    if (range.start > position) fragments.push({ type: "text", text: chars.slice(position, range.start).join("") });
    fragments.push({ type: "emote", name: chars.slice(range.start, range.end + 1).join(""), url: emoteUrl(range.id) });
    position = range.end + 1;
  }
  if (position < chars.length) fragments.push({ type: "text", text: chars.slice(position).join("") });
  return fragments;
}
