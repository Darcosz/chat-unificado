// Mensajes que el servidor local manda a la interfaz por WebSocket.
// Lo usan tanto el backend como la interfaz, así que no debe importar nada de Node.

import type { PublicConfig } from "./config.ts";
import type { ChatEvent, Platform } from "./event.ts";

export type ConnectionStatus = "disconnected" | "connecting" | "connected" | "reconnecting" | "error";

/** Texto que ve el usuario para cada estado, en la interfaz y en la consola. */
export const STATUS_TEXT: Record<ConnectionStatus, string> = {
  disconnected: "Sin conectar",
  connecting: "Conectando…",
  connected: "Conectado",
  reconnecting: "Reconectando…",
  error: "Error",
};

export interface PlatformStatus {
  status: ConnectionStatus;
  detail?: string;
}

export type ServerMessage =
  /** Al conectarse la interfaz: versión, configuración, estado de cada plataforma y los últimos eventos. */
  | {
      type: "init";
      version: string;
      config: PublicConfig;
      statuses: Record<Platform, PlatformStatus>;
      history: ChatEvent[];
    }
  | { type: "event"; event: ChatEvent }
  | { type: "status"; platform: Platform; status: ConnectionStatus; detail?: string }
  /** La configuración cambió (desde esta u otra ventana, por ejemplo el dock de OBS). */
  | { type: "config"; config: PublicConfig };

/** Ruta para guardar la configuración: PUT con un `ConfigChanges` en JSON. */
export const CONFIG_ROUTE = "/api/config";
