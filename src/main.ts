// Punto de entrada de la app: carga la configuración guardada, arranca el servidor local
// y deja que el gestor encienda los conectores que estén configurados.
// Uso: npm start
//      npm run demo        (eventos de prueba en las plataformas que aún no tienen conector)
//      npm start -- canal  (solo la primera vez: guarda ese canal de Twitch si no hay ninguno)

import { readFile } from "node:fs/promises";
import { styleText } from "node:util";
import { applyChanges, cleanTwitchChannel, toPublic } from "./core/config.ts";
import { ConnectorManager } from "./connector-manager.ts";
import { LocalServer } from "./server.ts";
import { DATA_DIR, loadConfig, saveConfig } from "./storage.ts";

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
});
const manager = new ConnectorManager(server, demoMode);

try {
  await server.start();
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}

console.log(`Interfaz lista en ${styleText(["cyan", "bold"], `http://localhost:${port}`)}`);
console.log(styleText("gray", `Configuración guardada en ${DATA_DIR}`));
await manager.apply(config);

process.on("SIGINT", () => {
  void manager
    .close()
    .then(() => server.close())
    .then(() => process.exit(0));
});
