// Base común de los conectores. Cada plataforma hereda de aquí, se reconecta sola
// y avisa de su estado para que la interfaz pueda mostrarlo.

import { EventEmitter } from "node:events";
import type { ChatEvent, Platform } from "./event.ts";
import type { ConnectionStatus } from "./protocol.ts";

export type { ConnectionStatus };

export type ConnectorEvents = {
  /** Un evento ya traducido al formato común. */
  event: [event: ChatEvent];
  /** Cambio de estado de la conexión, con un detalle opcional (motivo de la desconexión, error...). */
  status: [status: ConnectionStatus, detail: string | undefined];
  /** Espectadores del directo, o undefined si no se saben (sin directo, sin conexión...). */
  viewers: [count: number | undefined];
};

/** Cada cuánto se consulta el número de espectadores mientras hay conexión. */
const VIEWERS_INTERVAL = 60_000;

export abstract class Connector extends EventEmitter<ConnectorEvents> {
  abstract readonly platform: Platform;
  /**
   * true si la plataforma ya dice si es el primer mensaje del usuario (como Twitch).
   * Si es false, NUEVO se calcula con los usuarios ya vistos guardados en la PC.
   */
  readonly reportsFirstTime: boolean = false;

  #status: ConnectionStatus = "disconnected";
  #viewers: number | undefined;
  #viewersTimer: NodeJS.Timeout | undefined;

  get status(): ConnectionStatus {
    return this.#status;
  }

  protected setStatus(status: ConnectionStatus, detail?: string): void {
    if (status === this.#status && detail === undefined) return;
    this.#status = status;
    this.emit("status", status, detail);
    // Los espectadores solo se consultan mientras hay conexión.
    if (status === "connected") this.#startViewers();
    else this.#stopViewers();
  }

  get viewers(): number | undefined {
    return this.#viewers;
  }

  /** Para las plataformas que avisan solas del número de espectadores (TikTok). */
  protected setViewers(count: number | undefined): void {
    if (count === this.#viewers) return;
    this.#viewers = count;
    this.emit("viewers", count);
  }

  /**
   * Consulta el número de espectadores (undefined si no hay directo). Las plataformas que lo
   * implementan se consultan cada minuto mientras hay conexión; si falla, se deja el último valor.
   */
  protected fetchViewers?(): Promise<number | undefined>;

  #startViewers(): void {
    if (this.#viewersTimer || !this.fetchViewers) return;
    const update = async () => {
      try {
        const count = await this.fetchViewers!();
        if (this.#viewersTimer) this.setViewers(count);
      } catch {}
    };
    this.#viewersTimer = setInterval(() => void update(), VIEWERS_INTERVAL);
    void update();
  }

  #stopViewers(): void {
    clearInterval(this.#viewersTimer);
    this.#viewersTimer = undefined;
    this.setViewers(undefined);
  }

  abstract connect(): Promise<void>;
  abstract disconnect(): Promise<void>;
}
