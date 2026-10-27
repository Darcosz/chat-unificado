// Almacenamiento local: guarda la configuración y las sesiones en archivos JSON dentro de
// la carpeta de datos del usuario (%APPDATA%\chat-unificado en Windows). Cada PC tiene los suyos.

import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { defaultConfig, validateConfig, type Config } from "./core/config.ts";

export const DATA_DIR = process.env.CHAT_UNIFICADO_DATA_DIR ?? join(process.env.APPDATA ?? join(homedir(), ".config"), "chat-unificado");
const CONFIG_FILE = join(DATA_DIR, "config.json");
/** Tokens de Twitch. Va aparte de la configuración porque es un secreto. */
const TWITCH_SESSION_FILE = join(DATA_DIR, "twitch-session.json");

/** Lee un JSON. Devuelve undefined si no existe o no se puede leer. */
async function readJson(file: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      console.error(`No se pudo leer ${file}.`, error instanceof Error ? error.message : error);
    }
    return undefined;
  }
}

let queue: Promise<void> = Promise.resolve();

/** Guarda en orden y de forma atómica (archivo temporal + renombrar) para no dejar un JSON a medias. */
function writeJson(file: string, value: unknown): Promise<void> {
  // El catch evita que un fallo anterior bloquee los guardados siguientes.
  queue = queue.catch(() => {}).then(async () => {
    await mkdir(DATA_DIR, { recursive: true });
    const temp = `${file}.tmp`;
    await writeFile(temp, JSON.stringify(value, null, 2), "utf8");
    await rename(temp, file);
  });
  return queue;
}

export async function loadConfig(): Promise<Config> {
  const value = await readJson(CONFIG_FILE);
  return value === undefined ? defaultConfig() : validateConfig(value);
}

export function saveConfig(config: Config): Promise<void> {
  return writeJson(CONFIG_FILE, config);
}

export interface TwitchSession {
  accessToken: string;
  refreshToken: string;
  /** Momento en que caduca el access token (ms desde 1970). */
  expiresAt: number;
  userId: string;
  login: string;
  displayName: string;
  scopes: string[];
}

export async function loadTwitchSession(): Promise<TwitchSession | undefined> {
  const value = (await readJson(TWITCH_SESSION_FILE)) as Partial<TwitchSession> | undefined;
  const valid =
    value &&
    typeof value.accessToken === "string" &&
    typeof value.refreshToken === "string" &&
    typeof value.expiresAt === "number" &&
    typeof value.userId === "string" &&
    typeof value.login === "string";
  if (!valid) return undefined;
  return {
    accessToken: value.accessToken!,
    refreshToken: value.refreshToken!,
    expiresAt: value.expiresAt!,
    userId: value.userId!,
    login: value.login!,
    displayName: typeof value.displayName === "string" ? value.displayName : value.login!,
    scopes: Array.isArray(value.scopes) ? value.scopes.filter((s): s is string => typeof s === "string") : [],
  };
}

export function saveTwitchSession(session: TwitchSession): Promise<void> {
  return writeJson(TWITCH_SESSION_FILE, session);
}

export function deleteTwitchSession(): Promise<void> {
  queue = queue.catch(() => {}).then(() => rm(TWITCH_SESSION_FILE, { force: true }));
  return queue;
}
