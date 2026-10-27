// Conector de Twitch: lee el chat por IRC con tmi.js (lectura anónima, sin token) y, si hay
// sesión iniciada, recibe las alertas por EventSub. Todo se traduce al formato común.

import { randomUUID } from "node:crypto";
import tmi from "tmi.js";
import { Connector } from "../core/connector.ts";
import type { ChatEvent } from "../core/event.ts";
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
      this.emit("event", translateMessage(tags, message));
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

function translateMessage(tags: tmi.ChatUserstate, message: string): ChatEvent {
  const sentAt = Number(tags["tmi-sent-ts"]);
  return {
    id: tags.id ?? randomUUID(),
    platform: "twitch",
    type: "chat",
    user: {
      id: tags["user-id"] ?? "",
      name: tags["display-name"] ?? tags.username ?? "anónimo",
    },
    text: message,
    flags: {
      // Twitch marca con first-msg el primer mensaje del usuario en el canal.
      firstTime: Boolean(tags["first-msg"]),
      question: false,
    },
    timestamp: (Number.isFinite(sentAt) ? new Date(sentAt) : new Date()).toISOString(),
  };
}
