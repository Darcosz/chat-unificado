// Configuración de cada usuario (sección 3.6 de la especificación). Se guarda solo en su PC.
// Lo usan el backend y la interfaz, así que no debe importar nada de Node.

export type TextSize = "normal" | "large" | "extra-large";
export type AlertsSide = "left" | "right";

export interface Config {
  platforms: {
    twitch: { enabled: boolean; channel: string };
    tiktok: { enabled: boolean; username: string; eulerKey: string };
    youtube: { enabled: boolean };
    /** Canal de Kick tal como aparece en su dirección (kick.com/<canal>). */
    kick: { enabled: boolean; channel: string };
  };
  window: {
    alwaysOnTop: boolean;
    startWithWindows: boolean;
    textSize: TextSize;
    /** De qué lado del chat va el panel de alertas. */
    alertsSide: AlertsSide;
    /** De 0.5 a 1. */
    opacity: number;
  };
  tags: {
    markNew: boolean;
    markQuestion: boolean;
    /** Nombres o apodos que cuentan como mención al streamer. */
    mentions: string[];
  };
  autoUpdate: boolean;
}

/**
 * Lo que ve la interfaz: igual que la configuración pero sin secretos.
 * La clave de Euler nunca sale del backend; solo se dice si hay una guardada.
 */
export type PublicConfig = Omit<Config, "platforms"> & {
  platforms: Omit<Config["platforms"], "tiktok"> & {
    tiktok: { enabled: boolean; username: string; hasEulerKey: boolean };
  };
};

/** Lo que manda la interfaz al guardar. `newEulerKey` solo viene si el usuario escribió una. */
export type ConfigChanges = PublicConfig & { newEulerKey?: string };

export const TEXT_SIZES: readonly TextSize[] = ["normal", "large", "extra-large"];
export const ALERTS_SIDES: readonly AlertsSide[] = ["left", "right"];

export function defaultConfig(): Config {
  return {
    platforms: {
      twitch: { enabled: true, channel: "" },
      tiktok: { enabled: true, username: "", eulerKey: "" },
      youtube: { enabled: true },
      kick: { enabled: true, channel: "" },
    },
    window: { alwaysOnTop: true, startWithWindows: false, textSize: "normal", alertsSide: "right", opacity: 1 },
    tags: { markNew: true, markQuestion: true, mentions: [] },
    autoUpdate: true,
  };
}

export function toPublic(config: Config): PublicConfig {
  const { eulerKey, ...tiktok } = config.platforms.tiktok;
  return { ...config, platforms: { ...config.platforms, tiktok: { ...tiktok, hasEulerKey: eulerKey !== "" } } };
}

// ---------- Validación ----------
// Todo lo que llega de disco o de la interfaz pasa por aquí: lo que falte o venga mal
// se toma de `base`, así un archivo viejo o roto nunca tumba la app.

type Obj = Record<string, unknown>;

const asObject = (v: unknown): Obj => (typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Obj) : {});
const asBoolean = (v: unknown, base: boolean): boolean => (typeof v === "boolean" ? v : base);
const asText = (v: unknown, base: string, max = 200): string => (typeof v === "string" ? v.trim().slice(0, max) : base);

/** Nombre de canal de Twitch: minúsculas, sin # ni espacios. Devuelve "" si no es válido. */
export function cleanTwitchChannel(channel: string): string {
  const clean = channel.trim().replace(/^#/, "").replace(/^https?:\/\/(www\.)?twitch\.tv\//i, "").replace(/\/.*$/, "").toLowerCase();
  return /^[a-z0-9_]{1,25}$/.test(clean) ? clean : "";
}

/** Usuario de TikTok sin @ ni URL. Devuelve "" si no es válido. */
export function cleanTiktokUsername(username: string): string {
  const clean = username.trim().replace(/^https?:\/\/(www\.)?tiktok\.com\//i, "").replace(/^@/, "").replace(/\/.*$/, "");
  return /^[A-Za-z0-9_.]{1,24}$/.test(clean) ? clean : "";
}

/**
 * Canal de Kick como aparece en su dirección: minúsculas y con guiones en lugar de guiones
 * bajos (el usuario "mi_canal" está en kick.com/mi-canal). Devuelve "" si no es válido.
 */
export function cleanKickChannel(channel: string): string {
  const clean = channel.trim().replace(/^https?:\/\/(www\.)?kick\.com\//i, "").replace(/^@/, "").replace(/[/?#].*$/, "").toLowerCase().replaceAll("_", "-");
  return /^[a-z0-9-]{1,30}$/.test(clean) ? clean : "";
}

export function validateConfig(value: unknown, base: Config = defaultConfig()): Config {
  const root = asObject(value);
  const platforms = asObject(root.platforms);
  const twitch = asObject(platforms.twitch);
  const tiktok = asObject(platforms.tiktok);
  const kick = asObject(platforms.kick);
  const window = asObject(root.window);
  const tags = asObject(root.tags);

  const channel = typeof twitch.channel === "string" ? cleanTwitchChannel(twitch.channel) : base.platforms.twitch.channel;
  const username = typeof tiktok.username === "string" ? cleanTiktokUsername(tiktok.username) : base.platforms.tiktok.username;
  const opacity = typeof window.opacity === "number" && Number.isFinite(window.opacity) ? window.opacity : base.window.opacity;
  const mentions = Array.isArray(tags.mentions)
    ? [...new Set(tags.mentions.filter((m): m is string => typeof m === "string").map((m) => m.trim().replace(/^@/, "")).filter(Boolean))].slice(0, 50)
    : base.tags.mentions;

  return {
    platforms: {
      twitch: { enabled: asBoolean(twitch.enabled, base.platforms.twitch.enabled), channel },
      tiktok: {
        enabled: asBoolean(tiktok.enabled, base.platforms.tiktok.enabled),
        username,
        eulerKey: asText(tiktok.eulerKey, base.platforms.tiktok.eulerKey, 500),
      },
      youtube: { enabled: asBoolean(asObject(platforms.youtube).enabled, base.platforms.youtube.enabled) },
      kick: {
        enabled: asBoolean(kick.enabled, base.platforms.kick.enabled),
        channel: typeof kick.channel === "string" ? cleanKickChannel(kick.channel) : base.platforms.kick.channel,
      },
    },
    window: {
      alwaysOnTop: asBoolean(window.alwaysOnTop, base.window.alwaysOnTop),
      startWithWindows: asBoolean(window.startWithWindows, base.window.startWithWindows),
      textSize: TEXT_SIZES.includes(window.textSize as TextSize) ? (window.textSize as TextSize) : base.window.textSize,
      alertsSide: ALERTS_SIDES.includes(window.alertsSide as AlertsSide) ? (window.alertsSide as AlertsSide) : base.window.alertsSide,
      opacity: Math.min(1, Math.max(0.5, opacity)),
    },
    tags: {
      markNew: asBoolean(tags.markNew, base.tags.markNew),
      markQuestion: asBoolean(tags.markQuestion, base.tags.markQuestion),
      mentions,
    },
    autoUpdate: asBoolean(root.autoUpdate, base.autoUpdate),
  };
}

/** Aplica lo que manda la interfaz sobre la configuración actual, conservando la clave si no se cambió. */
export function applyChanges(current: Config, changes: unknown): Config {
  const root = asObject(changes);
  const newKey = root.newEulerKey;
  const platforms = asObject(root.platforms);
  const tiktok = { ...asObject(platforms.tiktok), eulerKey: typeof newKey === "string" ? newKey : current.platforms.tiktok.eulerKey };
  return validateConfig({ ...root, platforms: { ...platforms, tiktok } }, current);
}
