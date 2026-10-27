// Punto de entrada de la app: carga la configuración guardada, arranca el servidor local
// y deja que el gestor encienda los conectores que estén configurados.
// Uso: npm start
//      npm run demo        (eventos de prueba en las plataformas que aún no tienen conector)
//      npm start -- canal  (solo la primera vez: guarda ese canal de Twitch si no hay ninguno)

import { readFile } from "node:fs/promises";
import { styleText } from "node:util";
import { applyChanges, cleanTwitchChannel, toPublic } from "./core/config.ts";
import { STATUS_TEXT, TWITCH_ROUTES, type ConnectionStatus, type TwitchState } from "./core/protocol.ts";
import { ConnectorManager } from "./connector-manager.ts";
import { LocalServer } from "./server.ts";
import { DATA_DIR, loadConfig, saveConfig } from "./storage.ts";
import { TwitchAuth } from "./twitch/auth.ts";

const args = process.argv.slice(2);
const demoMode = args.includes("--demo");
const port = Number(process.env.PORT) || 4848;
const { version } = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8")) as { version: string };

let config = await loadConfig();

// Compatibilidad con el .env de los primeros pasos: si aún no hay canal guardado, se toma de ahí.
const initialChannel = cleanTwitchChannel(args.find((a) => !a.startsWith("--")) ?? process.env.TWITCH_CHANNEL ?? "");
if (!config.platforms.twitch.channel && initialChannel) {
  config.platforms.twitch.channel = initialChannel;
  await saveConfig(config);
}

// ---------- Twitch: sesión y estado de las alertas ----------

const twitchAuth = new TwitchAuth(process.env.TWITCH_CLIENT_ID);
await twitchAuth.init();
if (!twitchAuth.available) console.log(styleText("yellow", "Falta TWITCH_CLIENT_ID en .env: no se podrá iniciar sesión con Twitch."));

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
  config = { ...config, platforms: { ...config.platforms, twitch: { ...config.platforms.twitch, channel: login } } };
  await saveConfig(config);
  server.publishConfig(toPublic(config));
}

// ---------- Servidor y conectores ----------

const server = new LocalServer({
  port,
  version,
  config: toPublic(config),
  onSave: async (changes) => {
    const updated = applyChanges(config, changes);
    await saveConfig(updated);
    config = updated;
    void manager.apply(config);
    return toPublic(config);
  },
  twitch: twitchState(),
  actions: {
    [TWITCH_ROUTES.login]: () => twitchAuth.startLogin(),
    [TWITCH_ROUTES.cancelLogin]: async () => twitchAuth.cancelLogin(),
    [TWITCH_ROUTES.openLoginPage]: async () => twitchAuth.openLoginPage(),
    [TWITCH_ROUTES.logout]: () => twitchAuth.logout(),
  },
});

const manager = new ConnectorManager(server, demoMode, twitchAuth, (status, detail) => {
  twitchAlerts = detail === undefined ? { status } : { status, detail };
  console.log(`[twitch] alertas: ${STATUS_TEXT[status]}${detail ? `: ${detail}` : ""}`);
  server.publishTwitch(twitchState());
});

twitchAuth.on("change", () => {
  if (!twitchAuth.account) twitchAlerts = { status: "disconnected" };
  server.publishTwitch(twitchState());
  void useAccountChannel().then(() => manager.apply(config));
});

try {
  await server.start();
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}

console.log(`Interfaz lista en ${styleText(["cyan", "bold"], `http://localhost:${port}`)}`);
console.log(styleText("gray", `Datos guardados en ${DATA_DIR}`));
if (twitchAuth.account) console.log(styleText("gray", `Sesión de Twitch: ${twitchAuth.account.displayName}`));
await useAccountChannel();
await manager.apply(config);

process.on("SIGINT", () => {
  void manager
    .close()
    .then(() => server.close())
    .then(() => process.exit(0));
});
