// Arranque de la app: carga la configuración guardada, arranca el servidor local y deja que el
// gestor encienda los conectores configurados. Lo usan la versión de consola (src/main.ts) y la
// de escritorio (src/desktop/main.ts).

import { existsSync, readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { styleText } from "node:util";
import { applyChanges, cleanTwitchChannel, toPublic, type Config } from "./core/config.ts";
import {
  GOOGLE_CALLBACK_ROUTE,
  STATUS_TEXT,
  TWITCH_ROUTES,
  YOUTUBE_ROUTES,
  type ConnectionStatus,
  type TwitchState,
  type YouTubeState,
} from "./core/protocol.ts";
import { ConnectorManager } from "./connector-manager.ts";
import { APP_ROOT } from "./paths.ts";
import { LocalServer } from "./server.ts";
import { SeenUsers } from "./seen-users.ts";
import { DATA_DIR, loadConfig, saveConfig } from "./storage.ts";
import { TwitchAuth } from "./twitch/auth.ts";
import { GoogleAuth } from "./youtube/auth.ts";

export interface AppOptions {
  port: number;
  demoMode: boolean;
  /** Canal de Twitch a guardar si aún no hay ninguno (compatibilidad con los primeros pasos). */
  initialChannel?: string;
}

export interface RunningApp {
  port: number;
  version: string;
  config(): Config;
  /** Avisa cada vez que cambia la configuración (para aplicar "siempre encima", opacidad...). */
  onConfigChange(callback: (config: Config) => void): void;
  stop(): Promise<void>;
}

/**
 * Credenciales de las apps públicas (Client ID de Twitch, cliente de escritorio de Google), en
 * este orden de prioridad (lo primero que defina un valor gana):
 * 1. Un .env en la carpeta de datos del usuario: para cambiarlas sin reinstalar.
 * 2. El .env del proyecto (en desarrollo).
 * 3. Las integradas en el paquete al compilar (dist/credentials.json, ver scripts/embed-credentials.mjs).
 */
function loadCredentials(): void {
  for (const file of [join(DATA_DIR, ".env"), join(APP_ROOT, ".env")]) {
    if (existsSync(file)) process.loadEnvFile(file);
  }
  const embedded = join(APP_ROOT, "dist", "credentials.json");
  if (!existsSync(embedded)) return;
  try {
    const values = JSON.parse(readFileSync(embedded, "utf8")) as Record<string, unknown>;
    for (const [key, value] of Object.entries(values)) {
      if (typeof value === "string" && value && !process.env[key]) process.env[key] = value;
    }
  } catch {
    console.error("No se pudieron leer las credenciales integradas.");
  }
}

export async function startApp(options: AppOptions): Promise<RunningApp> {
  loadCredentials();
  const { port, demoMode } = options;
  const { version } = JSON.parse(await readFile(join(APP_ROOT, "package.json"), "utf8")) as { version: string };
  const configListeners: ((config: Config) => void)[] = [];

  let config = await loadConfig();

  const initialChannel = cleanTwitchChannel(options.initialChannel ?? process.env.TWITCH_CHANNEL ?? "");
  if (!config.platforms.twitch.channel && initialChannel) {
    config.platforms.twitch.channel = initialChannel;
    await saveConfig(config);
  }

  function setConfig(updated: Config): void {
    config = updated;
    for (const listener of configListeners) listener(config);
  }

  // ---------- Twitch: sesión y estado de las alertas ----------

  const twitchAuth = new TwitchAuth(process.env.TWITCH_CLIENT_ID);
  await twitchAuth.init();
  if (!twitchAuth.available) console.log(styleText("yellow", `Falta TWITCH_CLIENT_ID (en ${join(DATA_DIR, ".env")}): no se podrá iniciar sesión con Twitch.`));

  let twitchAlerts: { status: ConnectionStatus; detail?: string } = { status: "disconnected" };

  function twitchState(): TwitchState {
    const account = twitchAuth.account;
    return {
      available: twitchAuth.available,
      account: account
        ? { login: account.login, displayName: account.displayName, alerts: twitchAlerts.status, ...(twitchAlerts.detail ? { alertsDetail: twitchAlerts.detail } : {}) }
        : null,
      login: twitchAuth.flow,
    };
  }

  // Con sesión iniciada, el canal del chat es el de la cuenta.
  async function useAccountChannel(): Promise<void> {
    const login = twitchAuth.account?.login;
    if (!login || config.platforms.twitch.channel === login) return;
    const updated = { ...config, platforms: { ...config.platforms, twitch: { ...config.platforms.twitch, channel: login } } };
    await saveConfig(updated);
    setConfig(updated);
    server.publishConfig(toPublic(config));
  }

  // ---------- YouTube: sesión de Google ----------

  const googleAuth = new GoogleAuth({
    clientId: process.env.GOOGLE_CLIENT_ID,
    clientSecret: process.env.GOOGLE_CLIENT_SECRET,
    // Google acepta cualquier puerto en 127.0.0.1 para los clientes de escritorio.
    redirectUri: `http://127.0.0.1:${port}${GOOGLE_CALLBACK_ROUTE}`,
  });
  await googleAuth.init();
  if (!googleAuth.available) console.log(styleText("yellow", `Faltan GOOGLE_CLIENT_ID y GOOGLE_CLIENT_SECRET (en ${join(DATA_DIR, ".env")}): no se podrá conectar YouTube.`));

  function youtubeState(): YouTubeState {
    const account = googleAuth.account;
    return { available: googleAuth.available, account: account ?? null, login: googleAuth.flow };
  }

  // ---------- Servidor y conectores ----------

  const server = new LocalServer({
    port,
    version,
    config: toPublic(config),
    onSave: async (changes) => {
      const updated = applyChanges(config, changes);
      await saveConfig(updated);
      setConfig(updated);
      void manager.apply(config);
      return toPublic(config);
    },
    twitch: twitchState(),
    youtube: youtubeState(),
    actions: {
      [TWITCH_ROUTES.login]: () => twitchAuth.startLogin(),
      [TWITCH_ROUTES.cancelLogin]: async () => twitchAuth.cancelLogin(),
      [TWITCH_ROUTES.openLoginPage]: async () => twitchAuth.openLoginPage(),
      [TWITCH_ROUTES.logout]: () => twitchAuth.logout(),
      [YOUTUBE_ROUTES.login]: async () => googleAuth.startLogin(),
      [YOUTUBE_ROUTES.cancelLogin]: async () => googleAuth.cancelLogin(),
      [YOUTUBE_ROUTES.openLoginPage]: async () => googleAuth.openLoginPage(),
      [YOUTUBE_ROUTES.logout]: () => googleAuth.logout(),
    },
    pages: {
      [GOOGLE_CALLBACK_ROUTE]: (params) => googleAuth.handleCallback(params),
    },
  });

  const seenUsers = await SeenUsers.load();

  const manager = new ConnectorManager({
    server,
    demoMode,
    twitchAuth,
    googleAuth,
    seenUsers,
    onTwitchAlertsStatus: (status, detail) => {
      twitchAlerts = detail === undefined ? { status } : { status, detail };
      console.log(`[twitch] alertas: ${STATUS_TEXT[status]}${detail ? `: ${detail}` : ""}`);
      server.publishTwitch(twitchState());
    },
  });

  twitchAuth.on("change", () => {
    if (!twitchAuth.account) twitchAlerts = { status: "disconnected" };
    server.publishTwitch(twitchState());
    void useAccountChannel().then(() => manager.apply(config));
  });

  googleAuth.on("change", () => {
    server.publishYouTube(youtubeState());
    void manager.apply(config);
  });

  await server.start();

  console.log(`Interfaz lista en ${styleText(["cyan", "bold"], `http://localhost:${port}`)}`);
  console.log(styleText("gray", `Datos guardados en ${DATA_DIR}`));
  if (twitchAuth.account) console.log(styleText("gray", `Sesión de Twitch: ${twitchAuth.account.displayName}`));
  if (googleAuth.account) console.log(styleText("gray", `Sesión de YouTube: ${googleAuth.account.title}`));
  await useAccountChannel();
  await manager.apply(config);

  return {
    port,
    version,
    config: () => config,
    onConfigChange: (callback) => configListeners.push(callback),
    stop: async () => {
      await manager.close();
      await seenUsers.flush();
      await server.close();
    },
  };
}
