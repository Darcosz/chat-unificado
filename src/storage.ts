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

// ---------- Cifrado de secretos ----------
// La app de escritorio registra un codificador basado en safeStorage de Electron (en Windows,
// la protección de datos del propio sistema: solo tu usuario de Windows puede descifrarlo).
// Sin codificador (al correr con Node, en desarrollo) los secretos se guardan como antes.

export interface SecretCodec {
  encrypt(text: string): Promise<string>;
  decrypt(text: string): Promise<string>;
}

let codec: SecretCodec | undefined;

export function setSecretCodec(secretCodec: SecretCodec): void {
  codec = secretCodec;
}

/** Envuelve un valor secreto para guardarlo: { encrypted } si hay codificador, tal cual si no. */
async function seal(value: unknown): Promise<unknown> {
  return codec ? { encrypted: await codec.encrypt(JSON.stringify(value)) } : value;
}

/** Lo contrario de seal. Los archivos viejos sin cifrar se leen igual (se cifran al volver a guardarse). */
async function unseal(raw: unknown): Promise<unknown> {
  if (typeof raw !== "object" || raw === null || !("encrypted" in raw)) return raw;
  if (!codec) {
    console.error("Hay datos cifrados por la app de escritorio; con Node no se pueden leer.");
    return undefined;
  }
  try {
    return JSON.parse(await codec.decrypt(String((raw as { encrypted: unknown }).encrypted)));
  } catch {
    console.error("No se pudieron descifrar los datos guardados; habrá que volver a conectarse.");
    return undefined;
  }
}

const ENCRYPTED_PREFIX = "enc:";

/**
 * Clave de Euler cifrada que no se pudo descifrar (con Node no hay codificador). Se conserva
 * tal cual al guardar para no borrarla; solo se reemplaza si se escribe una clave nueva.
 */
let unreadableEulerKey: string | undefined;

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
  if (value === undefined) return defaultConfig();
  // La clave de Euler va cifrada dentro de la configuración ("enc:...").
  const tiktok = (value as { platforms?: { tiktok?: { eulerKey?: unknown } } }).platforms?.tiktok;
  if (tiktok && typeof tiktok.eulerKey === "string" && tiktok.eulerKey.startsWith(ENCRYPTED_PREFIX)) {
    const key = await unseal({ encrypted: tiktok.eulerKey.slice(ENCRYPTED_PREFIX.length) });
    unreadableEulerKey = typeof key === "string" ? undefined : tiktok.eulerKey;
    tiktok.eulerKey = typeof key === "string" ? key : "";
  }
  return validateConfig(value);
}

export async function saveConfig(config: Config): Promise<void> {
  const { eulerKey } = config.platforms.tiktok;
  if (eulerKey) unreadableEulerKey = undefined;
  if (unreadableEulerKey) {
    return writeJson(CONFIG_FILE, { ...config, platforms: { ...config.platforms, tiktok: { ...config.platforms.tiktok, eulerKey: unreadableEulerKey } } });
  }
  if (!codec || !eulerKey) return writeJson(CONFIG_FILE, config);
  const sealed = ((await seal(eulerKey)) as { encrypted: string }).encrypted;
  return writeJson(CONFIG_FILE, {
    ...config,
    platforms: { ...config.platforms, tiktok: { ...config.platforms.tiktok, eulerKey: ENCRYPTED_PREFIX + sealed } },
  });
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
  const value = (await unseal(await readJson(TWITCH_SESSION_FILE))) as Partial<TwitchSession> | undefined;
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

export async function saveTwitchSession(session: TwitchSession): Promise<void> {
  return writeJson(TWITCH_SESSION_FILE, await seal(session));
}

/** Tokens de Google para YouTube. Va aparte de la configuración porque es un secreto. */
const YOUTUBE_SESSION_FILE = join(DATA_DIR, "youtube-session.json");

export interface YouTubeSession {
  accessToken: string;
  refreshToken: string;
  /** Momento en que caduca el access token (ms desde 1970). */
  expiresAt: number;
  channelId: string;
  title: string;
}

export async function loadYouTubeSession(): Promise<YouTubeSession | undefined> {
  const value = (await unseal(await readJson(YOUTUBE_SESSION_FILE))) as Partial<YouTubeSession> | undefined;
  const valid =
    value &&
    typeof value.accessToken === "string" &&
    typeof value.refreshToken === "string" &&
    typeof value.expiresAt === "number" &&
    typeof value.channelId === "string" &&
    typeof value.title === "string";
  return valid ? (value as YouTubeSession) : undefined;
}

export async function saveYouTubeSession(session: YouTubeSession): Promise<void> {
  return writeJson(YOUTUBE_SESSION_FILE, await seal(session));
}

export function deleteYouTubeSession(): Promise<void> {
  queue = queue.catch(() => {}).then(() => rm(YOUTUBE_SESSION_FILE, { force: true }));
  return queue;
}

/** Ids de usuarios que ya escribieron alguna vez, por plataforma (para la etiqueta NUEVO). */
const SEEN_USERS_FILE = join(DATA_DIR, "seen-users.json");

export async function loadSeenUsers(): Promise<Record<string, string[]>> {
  const value = await readJson(SEEN_USERS_FILE);
  if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
  const result: Record<string, string[]> = {};
  for (const [platform, ids] of Object.entries(value)) {
    if (Array.isArray(ids)) result[platform] = ids.filter((id): id is string => typeof id === "string");
  }
  return result;
}

export function saveSeenUsers(seen: Record<string, string[]>): Promise<void> {
  return writeJson(SEEN_USERS_FILE, seen);
}

export function deleteTwitchSession(): Promise<void> {
  queue = queue.catch(() => {}).then(() => rm(TWITCH_SESSION_FILE, { force: true }));
  return queue;
}
