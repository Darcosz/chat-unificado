// Chat emergente de Kick en una ventana oculta de Electron. Es un navegador real que abre la
// página como cualquier espectador; aquí solo se escuchan, con las herramientas de depuración
// de Chromium, los mensajes que la página recibe por su WebSocket. No se resuelve ninguna
// comprobación de Cloudflare: si Kick la pide, se muestra la ventana para que la haga el usuario.

import { BrowserWindow, session } from "electron";
import type { KickPageOpener } from "../kick/page.ts";

/** Sesión propia y persistente: guarda las cookies de Kick entre arranques. */
const PARTITION = "persist:kick";
/** Lo que no hace falta para leer el chat; no se descarga para gastar menos. */
const BLOCKED = new Set(["image", "media", "font"]);
/**
 * Servicios de terceros que la página carga y no hacen falta para leer el chat: los pagos
 * (Stripe, cada uno en su propio marco) y las métricas (Datadog). Las comprobaciones de
 * Cloudflare y Google no se tocan.
 */
const BLOCKED_HOSTS = /(^|\.)(stripe\.com|stripe\.network|datadoghq-browser-agent\.com|datadoghq\.com)$/;
/** WebSockets de tiempo real de Kick (Centrifugo, y Pusher por si vuelven a él). */
const REALTIME_SOCKET = /^wss:\/\/([^/]+\.)?(kick\.com|pusher\.com)\//;
/** Título de la página de comprobación de Cloudflare (en inglés o en español). */
const CHALLENGE_TITLE = /just a moment|un momento|attention required/i;

let sessionReady = false;

function prepareSession(): Electron.Session {
  const kickSession = session.fromPartition(PARTITION);
  if (!sessionReady) {
    sessionReady = true;
    kickSession.webRequest.onBeforeRequest((details, callback) => {
      // Mientras la ventana se ve (comprobación de Cloudflare) se carga todo.
      const visible = details.webContents ? BrowserWindow.fromWebContents(details.webContents)?.isVisible() : false;
      const host = new URL(details.url).hostname;
      callback({ cancel: BLOCKED_HOSTS.test(host) || (BLOCKED.has(details.resourceType) && !visible) });
    });
    // Ningún permiso (cámara, micrófono, notificaciones...): pedirlos arranca servicios que gastan memoria.
    kickSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    kickSession.setPermissionCheckHandler(() => false);
  }
  return kickSession;
}

export const openKickPage: KickPageOpener = (channel, handlers) => {
  const window = new BrowserWindow({
    show: false,
    // Mientras está oculta no se dibuja: solo importan los mensajes.
    paintWhenInitiallyHidden: false,
    width: 440,
    height: 680,
    title: `Kick: ${channel}`,
    autoHideMenuBar: true,
    webPreferences: {
      session: prepareSession(),
      // Oculta, Chromium frenaría sus temporizadores y el chat llegaría tarde.
      backgroundThrottling: false,
      contextIsolation: true,
      sandbox: true,
      spellcheck: false,
    },
  });
  const contents = window.webContents;
  contents.setAudioMuted(true);
  contents.setWindowOpenHandler(() => ({ action: "deny" }));

  let closed = false;
  let challenge = false;
  // Si el usuario cierra la ventana de la comprobación, solo se oculta.
  window.on("close", (event) => {
    if (closed) return;
    event.preventDefault();
    window.hide();
  });

  // ---------- WebSocket de la página ----------

  const sockets = new Set<string>();
  const debug = contents.debugger;
  debug.on("message", (_event, method: string, params: Record<string, any>) => {
    if (method === "Network.webSocketCreated" && REALTIME_SOCKET.test(params.url)) {
      sockets.add(params.requestId);
      handlers.socketOpened();
    } else if (method === "Network.webSocketFrameReceived" && sockets.has(params.requestId)) {
      handlers.frame(params.response.payloadData);
    } else if (method === "Network.webSocketClosed" && sockets.delete(params.requestId)) {
      handlers.socketClosed();
    }
  });
  try {
    debug.attach("1.3");
    void debug.sendCommand("Network.enable").catch(() => {});
  } catch (error) {
    handlers.loadFailed(error instanceof Error ? error.message : String(error));
  }

  // ---------- Carga y comprobación de Cloudflare ----------

  const checkChallenge = () => {
    if (closed) return;
    const active = CHALLENGE_TITLE.test(contents.getTitle());
    if (active === challenge) return;
    challenge = active;
    if (active) {
      window.setTitle("Kick: comprueba que eres una persona");
      window.show();
    } else {
      window.hide();
    }
    handlers.challenge(active);
  };
  contents.on("page-title-updated", checkChallenge);
  contents.on("did-finish-load", checkChallenge);
  contents.on("did-fail-load", (_event, code, description, _url, isMainFrame) => {
    // -3 es una carga cancelada (por ejemplo, al recargar): no es un fallo.
    if (isMainFrame && code !== -3) handlers.loadFailed(description);
  });

  const url = `https://kick.com/popout/${encodeURIComponent(channel)}/chat`;
  void window.loadURL(url).catch(() => {});

  return {
    reload: () => {
      if (closed) return;
      sockets.clear();
      void window.loadURL(url).catch(() => {});
    },
    close: () => {
      if (closed) return;
      closed = true;
      try {
        debug.detach();
      } catch {}
      window.destroy();
    },
  };
};
