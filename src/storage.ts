// Almacenamiento local: guarda la configuración en un JSON dentro de la carpeta de datos
// del usuario (%APPDATA%\chat-unificado en Windows). Cada PC tiene la suya.

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { defaultConfig, validateConfig, type Config } from "./core/config.ts";

export const DATA_DIR = process.env.CHAT_UNIFICADO_DATA_DIR ?? join(process.env.APPDATA ?? join(homedir(), ".config"), "chat-unificado");
const CONFIG_FILE = join(DATA_DIR, "config.json");

export async function loadConfig(): Promise<Config> {
  try {
    return validateConfig(JSON.parse(await readFile(CONFIG_FILE, "utf8")));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      console.error(`No se pudo leer ${CONFIG_FILE}; se usa la configuración por defecto.`, error instanceof Error ? error.message : error);
    }
    return defaultConfig();
  }
}

let queue: Promise<void> = Promise.resolve();

/** Guarda en orden y de forma atómica (archivo temporal + renombrar) para no dejar un JSON a medias. */
export function saveConfig(config: Config): Promise<void> {
  // El catch evita que un fallo anterior bloquee los guardados siguientes.
  queue = queue.catch(() => {}).then(async () => {
    await mkdir(DATA_DIR, { recursive: true });
    const temp = `${CONFIG_FILE}.tmp`;
    await writeFile(temp, JSON.stringify(config, null, 2), "utf8");
    await rename(temp, CONFIG_FILE);
  });
  return queue;
}
