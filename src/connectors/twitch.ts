// Conector de Twitch: lee el chat por IRC con tmi.js (lectura anónima, sin token)
// y lo traduce al formato común. Las alertas llegarán por EventSub en el paso 5.

import { randomUUID } from "node:crypto";
import tmi from "tmi.js";
import { Connector } from "../core/connector.ts";
import type { ChatEvent } from "../core/event.ts";

export class TwitchConnector extends Connector {
  readonly platform = "twitch";
  readonly channel: string;

  #client: tmi.Client;
  /** true mientras cerramos a propósito, para no confundirlo con una caída. */
  #closing = false;

  constructor(channel: string) {
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
  }

  async connect(): Promise<void> {
    this.#closing = false;
    try {
      await this.#client.connect();
    } catch (error) {
      // Si falla el primer intento, tmi.js sigue reintentando por su cuenta.
      this.setStatus("error", error instanceof Error ? error.message : String(error));
    }
  }

  async disconnect(): Promise<void> {
    this.#closing = true;
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
