// Conector de prueba: inventa mensajes y alertas para ver la interfaz con todas las
// plataformas sin tener cuentas conectadas. Se activa con --demo.

import { randomUUID } from "node:crypto";
import { Connector } from "../core/connector.ts";
import type { ChatEvent, EventType, Platform } from "../core/event.ts";

const NAMES = ["lalo_gamer", "sofi.mx", "Andrea Ruiz", "el_toro", "nightowl", "marco_dev", "dani.plays", "Luis M.", "neo_mx", "pixel_kat"];

const MESSAGES = [
  "¡Buenas! ¿Qué juego toca hoy?",
  "Primera vez por aquí, saludos desde Guadalajara",
  "jajaja ese salto estuvo increíble",
  "¿Qué sensibilidad de mouse usas?",
  "denle like al live",
  "¿A qué hora es el próximo stream?",
  "GG",
  "esa música está buenísima",
  "saludos a todos los del chat 👋",
  "no manches, casi",
];

/** Alertas que tiene cada plataforma (sección 3.4 de la especificación). */
const ALERTS: Record<Platform, Exclude<EventType, "chat">[]> = {
  twitch: ["follow", "sub", "giftsub", "bits", "reward", "raid"],
  tiktok: ["follow", "gift"],
  youtube: ["member", "superchat"],
  kick: ["follow", "sub", "kicks"],
};

function pick<T>(list: readonly T[]): T {
  return list[Math.floor(Math.random() * list.length)]!;
}

export class DemoConnector extends Connector {
  readonly platform: Platform;
  #timer: NodeJS.Timeout | undefined;

  constructor(platform: Platform) {
    super();
    this.platform = platform;
  }

  async connect(): Promise<void> {
    this.setStatus("connecting");
    this.#timer = setTimeout(() => {
      this.setStatus("connected");
      this.#schedule();
    }, 500 + Math.random() * 1500);
  }

  async disconnect(): Promise<void> {
    clearTimeout(this.#timer);
    this.setStatus("disconnected");
  }

  #schedule(): void {
    this.#timer = setTimeout(() => {
      this.emit("event", Math.random() < 0.85 ? this.#chat() : this.#alert());
      this.#schedule();
    }, 1500 + Math.random() * 4000);
  }

  #base(type: EventType): ChatEvent {
    const name = pick(NAMES);
    return {
      id: randomUUID(),
      platform: this.platform,
      type,
      user: { id: name, name },
      flags: { firstTime: false, question: false },
      timestamp: new Date().toISOString(),
    };
  }

  #chat(): ChatEvent {
    const event = this.#base("chat");
    event.text = pick(MESSAGES);
    // PREGUNTA la calculan las reglas, igual que con los conectores reales.
    event.flags.firstTime = Math.random() < 0.15;

    // En Twitch, a veces un emote, un mensaje con bits o uno destacado con puntos.
    if (this.platform === "twitch") {
      const roll = Math.random();
      if (roll < 0.15) {
        event.text = `Kappa ${event.text}`;
        event.fragments = [
          { type: "emote", name: "Kappa", url: "https://static-cdn.jtvnw.net/emoticons/v2/25/default/dark/2.0" },
          { type: "text", text: event.text.slice(5) },
        ];
      } else if (roll < 0.25) {
        event.highlight = "bits";
        event.amount = pick([100, 500]);
      } else if (roll < 0.35) {
        event.highlight = "highlighted";
      }
    }
    return event;
  }

  #alert(): ChatEvent {
    const event = this.#base(pick(ALERTS[this.platform]));
    switch (event.type) {
      case "sub":
        event.amount = pick([1, 3, 12]);
        event.detail = "Nivel 1";
        break;
      case "giftsub":
        event.amount = pick([1, 5, 10]);
        event.detail = "Nivel 1";
        break;
      case "member":
        event.detail = "Nivel: Fan";
        break;
      case "bits":
        event.amount = pick([100, 500, 1000]);
        event.text = "¡Vamos con todo!";
        break;
      case "superchat":
        event.amount = 50;
        event.detail = "MX$50.00";
        event.text = "¡Saludos desde Monterrey!";
        break;
      case "kicks":
        event.amount = pick([10, 100]);
        break;
      case "gift":
        event.detail = pick(["Rosa", "Dona", "León"]);
        event.amount = pick([1, 5, 30]);
        break;
      case "reward":
        event.detail = "Hidrátate";
        event.amount = 1000;
        break;
      case "raid":
        event.amount = pick([1, 12, 150]);
        break;
    }
    return event;
  }
}
