// Servidor local: sirve la interfaz en http://localhost:<puerto> (la misma URL vale
// para la ventana de la app y para el dock de OBS), le manda los eventos por WebSocket
// y recibe los cambios de configuración.

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocket, WebSocketServer } from "ws";
import type { PublicConfig } from "./core/config.ts";
import { PLATFORMS, isChat, type ChatEvent, type Platform } from "./core/event.ts";
import { CONFIG_ROUTE, type ConnectionStatus, type PlatformStatus, type ServerMessage, type TwitchState, type YouTubeState } from "./core/protocol.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

/** Prefijo de la URL → carpeta del proyecto de la que se sirve. Se revisan en orden. */
const STATIC_DIRS: [prefix: string, dir: string][] = [
  ["/js/", join(ROOT, "dist", "web")],
  ["/fonts/inter/", join(ROOT, "node_modules", "@fontsource-variable", "inter")],
  ["/", join(ROOT, "src", "ui")],
];

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".woff2": "font/woff2",
};

/** Cuántos eventos se guardan para mandarlos a una interfaz que se acaba de abrir. */
const CHAT_HISTORY = 200;
const ALERT_HISTORY = 100;

/** Tamaño máximo del JSON de configuración que se acepta. */
const MAX_BODY = 64 * 1024;

export interface ServerOptions {
  port: number;
  version: string;
  config: PublicConfig;
  /** Valida y guarda los cambios. Devuelve la configuración resultante o lanza si no se pudo. */
  onSave: (changes: unknown) => Promise<PublicConfig>;
  twitch: TwitchState;
  youtube: YouTubeState;
  /** Acciones sin cuerpo que la interfaz pide con POST (ruta → acción). */
  actions: Record<string, () => Promise<void>>;
  /**
   * Páginas GET que abre el navegador del usuario fuera de la interfaz (la vuelta del inicio
   * de sesión de Google). Reciben los parámetros de la URL y devuelven el texto a mostrar.
   */
  pages: Record<string, (params: URLSearchParams) => Promise<{ ok: boolean; message: string }>>;
}

export class LocalServer {
  readonly port: number;
  readonly #version: string;
  readonly #onSave: ServerOptions["onSave"];
  readonly #actions: ServerOptions["actions"];
  readonly #pages: ServerOptions["pages"];
  #twitch: TwitchState;
  #youtube: YouTubeState;

  #http = createServer((request, response) => void this.#handle(request, response));
  #ws: WebSocketServer;
  #config: PublicConfig;
  #chat: ChatEvent[] = [];
  #alerts: ChatEvent[] = [];
  #statuses = Object.fromEntries(
    PLATFORMS.map((p) => [p, { status: "disconnected" }]),
  ) as Record<Platform, PlatformStatus>;

  constructor(options: ServerOptions) {
    this.port = options.port;
    this.#version = options.version;
    this.#config = options.config;
    this.#onSave = options.onSave;
    this.#twitch = options.twitch;
    this.#youtube = options.youtube;
    this.#actions = options.actions;
    this.#pages = options.pages;

    this.#ws = new WebSocketServer({
      server: this.#http,
      path: "/ws",
      // Solo aceptamos páginas servidas por nosotros, para que una web cualquiera
      // abierta en el navegador no pueda leer el chat desde ws://localhost.
      verifyClient: ({ origin, req }: { origin: string | undefined; req: IncomingMessage }) =>
        this.#isAllowedHost(req) && (!origin || this.#isAllowedOrigin(origin)),
    });
    this.#ws.on("connection", (client) => {
      const history = [...this.#chat, ...this.#alerts].sort((a, b) => a.timestamp.localeCompare(b.timestamp));
      send(client, {
        type: "init",
        version: this.#version,
        config: this.#config,
        statuses: this.#statuses,
        history,
        twitch: this.#twitch,
        youtube: this.#youtube,
      });
    });
  }

  start(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.#http.once("error", (error: NodeJS.ErrnoException) => {
        reject(error.code === "EADDRINUSE" ? new Error(`El puerto ${this.port} ya está en uso. ¿Hay otra copia de la app abierta?`) : error);
      });
      this.#http.listen(this.port, "127.0.0.1", () => resolve());
    });
  }

  async close(): Promise<void> {
    for (const client of this.#ws.clients) client.terminate();
    await new Promise<void>((done) => this.#ws.close(() => done()));
    await new Promise<void>((done) => this.#http.close(() => done()));
  }

  publishEvent(event: ChatEvent): void {
    const list = isChat(event) ? this.#chat : this.#alerts;
    list.push(event);
    if (list.length > (isChat(event) ? CHAT_HISTORY : ALERT_HISTORY)) list.shift();
    this.#broadcast({ type: "event", event });
  }

  publishStatus(platform: Platform, status: ConnectionStatus, detail?: string): void {
    this.#statuses[platform] = detail === undefined ? { status } : { status, detail };
    this.#broadcast(detail === undefined ? { type: "status", platform, status } : { type: "status", platform, status, detail });
  }

  publishTwitch(twitch: TwitchState): void {
    this.#twitch = twitch;
    this.#broadcast({ type: "twitch", twitch });
  }

  publishYouTube(youtube: YouTubeState): void {
    this.#youtube = youtube;
    this.#broadcast({ type: "youtube", youtube });
  }

  /** Para cambios de configuración que no vienen de la interfaz (por ejemplo, al iniciar sesión). */
  publishConfig(config: PublicConfig): void {
    this.#config = config;
    this.#broadcast({ type: "config", config });
  }

  #broadcast(message: ServerMessage): void {
    for (const client of this.#ws.clients) send(client, message);
  }

  #isAllowedOrigin(origin: string): boolean {
    return origin === `http://localhost:${this.port}` || origin === `http://127.0.0.1:${this.port}`;
  }

  /** Rechaza peticiones con otro Host, para que una web no pueda colarse con DNS rebinding. */
  #isAllowedHost(request: IncomingMessage): boolean {
    const host = request.headers.host;
    return host === `localhost:${this.port}` || host === `127.0.0.1:${this.port}`;
  }

  async #handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (!this.#isAllowedHost(request)) {
      sendText(response, 403, "Prohibido");
      return;
    }

    let path: string;
    try {
      path = decodeURIComponent(new URL(request.url ?? "/", "http://localhost").pathname);
    } catch {
      sendText(response, 400, "Ruta no válida");
      return;
    }

    if (path === CONFIG_ROUTE) {
      await this.#saveConfig(request, response);
    } else if (Object.hasOwn(this.#actions, path)) {
      await this.#runAction(this.#actions[path]!, request, response);
    } else if (Object.hasOwn(this.#pages, path) && request.method === "GET") {
      await this.#servePage(this.#pages[path]!, new URL(request.url ?? "/", "http://localhost").searchParams, response);
    } else if (request.method === "GET" || request.method === "HEAD") {
      await this.#serveFile(path, response);
    } else {
      sendText(response, 405, "Método no permitido");
    }
  }

  /**
   * Comprueba que una petición que cambia algo venga de nuestra interfaz. Los navegadores
   * siempre mandan Origin en un PUT o POST; si falta o es ajeno, no es nuestra.
   */
  #checkWrite(request: IncomingMessage, response: ServerResponse, method: "PUT" | "POST"): boolean {
    if (request.method !== method) {
      sendText(response, 405, "Método no permitido");
      return false;
    }
    const origin = request.headers.origin;
    if (!origin || !this.#isAllowedOrigin(origin)) {
      sendText(response, 403, "Prohibido");
      return false;
    }
    return true;
  }

  async #runAction(action: () => Promise<void>, request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (!this.#checkWrite(request, response, "POST")) return;
    try {
      await action();
      sendText(response, 204, "");
    } catch (error) {
      console.error("Falló una acción:", error);
      sendText(response, 500, error instanceof Error ? error.message : "Error");
    }
  }

  /** Página sencilla con el resultado (por ejemplo, "Listo, ya puedes cerrar esta pestaña"). */
  async #servePage(page: ServerOptions["pages"][string], params: URLSearchParams, response: ServerResponse): Promise<void> {
    let result: { ok: boolean; message: string };
    try {
      result = await page(params);
    } catch (error) {
      result = { ok: false, message: error instanceof Error ? error.message : "Error inesperado" };
    }
    const escaped = result.message.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
    response.writeHead(result.ok ? 200 : 400, { "Content-Type": MIME_TYPES[".html"]!, "Cache-Control": "no-store" });
    response.end(
      `<!doctype html><html lang="es"><head><meta charset="utf-8"><title>Chat Unificado</title>` +
        `<style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0f1115;color:#e8eaed;font:16px system-ui,sans-serif}` +
        `p{max-width:440px;padding:24px;border:1px solid ${result.ok ? "#34d399" : "#f87171"};border-radius:12px;background:#151821;line-height:1.5}</style>` +
        `</head><body><p>${escaped}</p></body></html>`,
    );
  }

  async #saveConfig(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (!this.#checkWrite(request, response, "PUT")) return;

    let changes: unknown;
    try {
      changes = JSON.parse(await readBody(request));
    } catch {
      sendText(response, 400, "JSON no válido");
      return;
    }

    try {
      this.#config = await this.#onSave(changes);
    } catch (error) {
      console.error("No se pudo guardar la configuración:", error);
      sendText(response, 500, "No se pudo guardar la configuración");
      return;
    }

    response.writeHead(200, { "Content-Type": MIME_TYPES[".json"]!, "Cache-Control": "no-store" });
    response.end(JSON.stringify(this.#config));
    this.#broadcast({ type: "config", config: this.#config });
  }

  async #serveFile(path: string, response: ServerResponse): Promise<void> {
    if (path === "/" || path === "/chat") path = "/index.html";

    const match = STATIC_DIRS.find(([prefix]) => path.startsWith(prefix));
    if (match) {
      const [prefix, dir] = match;
      const file = resolve(dir, "." + path.slice(prefix.length - 1));
      // Evita salir de la carpeta con rutas tipo /../../
      if (file.startsWith(dir + sep)) {
        try {
          const content = await readFile(file);
          response.writeHead(200, {
            "Content-Type": MIME_TYPES[extname(file)] ?? "application/octet-stream",
            "Cache-Control": "no-store",
          });
          response.end(content);
          return;
        } catch {
          // No existe: cae al 404.
        }
      }
    }

    sendText(response, 404, "No encontrado");
  }
}

function send(client: WebSocket, message: ServerMessage): void {
  if (client.readyState === WebSocket.OPEN) client.send(JSON.stringify(message));
}

function sendText(response: ServerResponse, code: number, text: string): void {
  response.writeHead(code, { "Content-Type": "text/plain; charset=utf-8" });
  response.end(text);
}

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > MAX_BODY) throw new Error("Cuerpo demasiado grande");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}
