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
};

export abstract class Connector extends EventEmitter<ConnectorEvents> {
  abstract readonly platform: Platform;
  /**
   * true si la plataforma ya dice si es el primer mensaje del usuario (como Twitch).
   * Si es false, NUEVO se calcula con los usuarios ya vistos guardados en la PC.
   */
  readonly reportsFirstTime: boolean = false;

  #status: ConnectionStatus = "disconnected";

  get status(): ConnectionStatus {
    return this.#status;
  }

  protected setStatus(status: ConnectionStatus, detail?: string): void {
    if (status === this.#status && detail === undefined) return;
    this.#status = status;
    this.emit("status", status, detail);
  }

  abstract connect(): Promise<void>;
  abstract disconnect(): Promise<void>;
}
