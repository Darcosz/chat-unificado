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

/** Cuenta de Twitch con la que se inició sesión (sin tokens: esos no salen del backend). */
export interface TwitchAccount {
  login: string;
  displayName: string;
  /** Estado de la conexión de alertas (EventSub). */
  alerts: ConnectionStatus;
  alertsDetail?: string;
}

/** Paso en el que va el inicio de sesión con Twitch. */
export type TwitchLoginFlow =
  | { state: "idle" }
  /** Esperando a que el usuario autorice en la página de Twitch. */
  | { state: "waiting"; userCode: string; verificationUri: string }
  | { state: "error"; message: string };

export interface TwitchState {
  /** false si falta el Client ID: entonces no se puede iniciar sesión. */
  available: boolean;
  account: TwitchAccount | null;
  login: TwitchLoginFlow;
}

/** Canal de YouTube con el que se inició sesión (sin tokens). */
export interface YouTubeAccount {
  channelId: string;
  title: string;
}

/** Paso en el que va el inicio de sesión con Google. */
export type YouTubeLoginFlow =
  | { state: "idle" }
  /** Se abrió la página de Google y se espera a que el usuario autorice. */
  | { state: "waiting" }
  | { state: "error"; message: string };

export interface YouTubeState {
  /** false si faltan GOOGLE_CLIENT_ID o GOOGLE_CLIENT_SECRET: entonces no se puede iniciar sesión. */
  available: boolean;
  account: YouTubeAccount | null;
  login: YouTubeLoginFlow;
}

export type ServerMessage =
  /** Al conectarse la interfaz: versión, configuración, estado de cada plataforma y los últimos eventos. */
  | {
      type: "init";
      version: string;
      config: PublicConfig;
      statuses: Record<Platform, PlatformStatus>;
      history: ChatEvent[];
      twitch: TwitchState;
      youtube: YouTubeState;
    }
  /** Cambió la cuenta de Twitch, el paso del inicio de sesión o el estado de las alertas. */
  | { type: "twitch"; twitch: TwitchState }
  /** Cambió la cuenta de YouTube o el paso del inicio de sesión. */
  | { type: "youtube"; youtube: YouTubeState }
  | { type: "event"; event: ChatEvent }
  | { type: "status"; platform: Platform; status: ConnectionStatus; detail?: string }
  /** La configuración cambió (desde esta u otra ventana, por ejemplo el dock de OBS). */
  | { type: "config"; config: PublicConfig };

/** Ruta para guardar la configuración: PUT con un `ConfigChanges` en JSON. */
export const CONFIG_ROUTE = "/api/config";

/** Acciones de Twitch: POST sin cuerpo. */
export const TWITCH_ROUTES = {
  login: "/api/twitch/login",
  cancelLogin: "/api/twitch/login/cancel",
  openLoginPage: "/api/twitch/login/open",
  logout: "/api/twitch/logout",
} as const;

/** Acciones de YouTube: POST sin cuerpo. */
export const YOUTUBE_ROUTES = {
  login: "/api/youtube/login",
  cancelLogin: "/api/youtube/login/cancel",
  openLoginPage: "/api/youtube/login/open",
  logout: "/api/youtube/logout",
} as const;

/** Página a la que Google redirige tras autorizar (GET, la abre el navegador del usuario). */
export const GOOGLE_CALLBACK_ROUTE = "/oauth/google/callback";
