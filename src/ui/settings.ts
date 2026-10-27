// Pantalla de configuración: pinta la configuración que manda el servidor y le envía
// cada cambio en cuanto el usuario lo hace (no hay botón de "Guardar").

import { cleanTiktokUsername, cleanTwitchChannel, type ConfigChanges, type PublicConfig } from "../core/config.ts";
import type { Platform } from "../core/event.ts";
import { CONFIG_ROUTE, STATUS_TEXT, type ConnectionStatus } from "../core/protocol.ts";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const form = $<HTMLFormElement>("settings-form");
const twitchChannel = $<HTMLInputElement>("twitch-channel");
const twitchChannelError = $("twitch-channel-error");
const tiktokUsername = $<HTMLInputElement>("tiktok-username");
const tiktokUsernameError = $("tiktok-username-error");
const eulerKey = $<HTMLInputElement>("euler-key");
const clearKey = $<HTMLButtonElement>("clear-key");
const mentions = $<HTMLInputElement>("mentions");
const opacityValue = $<HTMLOutputElement>("opacity-value");
const dockUrl = $<HTMLInputElement>("dock-url");
const toast = $("toast");

let current: PublicConfig | undefined;
let onConfigChange: (config: PublicConfig) => void = () => {};

// ---------- Acceso a campos por ruta ("window.opacity") ----------

function readPath(object: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>((value, key) => (value as Record<string, unknown> | undefined)?.[key], object);
}

function writePath(object: object, path: string, value: unknown): void {
  const keys = path.split(".");
  const last = keys.pop()!;
  const target = keys.reduce<Record<string, unknown>>((o, key) => o[key] as Record<string, unknown>, object as Record<string, unknown>);
  target[last] = value;
}

// ---------- Pintar ----------

/**
 * Pone el valor de un campo de texto sin pisar lo que el usuario está escribiendo
 * ni un valor no válido que aún tiene que corregir.
 */
function setText(input: HTMLInputElement, value: string): void {
  if (document.activeElement !== input && input.getAttribute("aria-invalid") !== "true") input.value = value;
}

export function renderSettings(config: PublicConfig): void {
  current = config;

  for (const input of form.querySelectorAll<HTMLInputElement>("input[data-field]")) {
    const value = readPath(config, input.dataset.field!);
    if (input.type === "checkbox") input.checked = value === true;
    else if (input.type === "radio") input.checked = input.value === value;
    else if (document.activeElement !== input) input.value = String(value);
  }

  for (const card of form.querySelectorAll<HTMLElement>(".card[data-platform]")) {
    const platform = card.dataset.platform as Platform;
    card.toggleAttribute("data-disabled", !config.platforms[platform].enabled);
  }

  setText(twitchChannel, config.platforms.twitch.channel);
  setText(tiktokUsername, config.platforms.tiktok.username ? `@${config.platforms.tiktok.username}` : "");
  setText(mentions, config.tags.mentions.join(", "));
  eulerKey.placeholder = config.platforms.tiktok.hasEulerKey ? "•••••••• guardada" : "Pega aquí tu clave";
  clearKey.hidden = !config.platforms.tiktok.hasEulerKey;
  opacityValue.value = `${Math.round(config.window.opacity * 100)}%`;

  onConfigChange(config);
}

export function setCardStatus(platform: Platform, status: ConnectionStatus, detail?: string): void {
  const label = form.querySelector<HTMLElement>(`[data-status-of="${platform}"]`);
  if (!label) return;
  label.dataset.status = status;
  label.textContent = STATUS_TEXT[status];
  label.title = detail ?? "";
}

// ---------- Guardar ----------

let toastTimer: ReturnType<typeof setTimeout> | undefined;

function showToast(text: string, kind: "ok" | "error" = "ok"): void {
  toast.textContent = text;
  toast.dataset.kind = kind;
  toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (toast.hidden = true), kind === "error" ? 4000 : 1500);
}

let saveQueue: Promise<void> = Promise.resolve();

/**
 * Copia la configuración actual, le aplica `modify` y la manda al servidor.
 * Los guardados van en fila: cada uno parte de lo que dejó el anterior, así dos
 * cambios seguidos no se pisan.
 */
function save(modify: (changes: ConfigChanges) => void): Promise<void> {
  saveQueue = saveQueue.then(() => sendChanges(modify));
  return saveQueue;
}

async function sendChanges(modify: (changes: ConfigChanges) => void): Promise<void> {
  if (!current) return;
  const changes: ConfigChanges = structuredClone(current);
  modify(changes);

  try {
    const response = await fetch(CONFIG_ROUTE, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(changes),
    });
    if (!response.ok) throw new Error(await response.text());
    renderSettings((await response.json()) as PublicConfig);
    showToast("Guardado");
  } catch (error) {
    showToast(`No se pudo guardar: ${error instanceof Error ? error.message : String(error)}`, "error");
    // Vuelve a pintar lo último que sí está guardado.
    renderSettings(current);
  }
}

// ---------- Eventos del formulario ----------

form.addEventListener("submit", (event) => event.preventDefault());

// Interruptores, tamaño de texto y opacidad.
form.addEventListener("change", (event) => {
  const input = event.target as HTMLInputElement;
  const path = input.dataset.field;
  if (!path) return;
  const value = input.type === "checkbox" ? input.checked : input.type === "range" ? Number(input.value) : input.value;
  void save((changes) => writePath(changes, path, value));
});

// La opacidad se muestra mientras se arrastra; se guarda al soltar (evento change).
form.addEventListener("input", (event) => {
  const input = event.target as HTMLInputElement;
  if (input.dataset.field === "window.opacity") opacityValue.value = `${Math.round(Number(input.value) * 100)}%`;
});

/** Un campo de texto se guarda al salir de él o al pulsar Enter, si cambió y es válido. */
function textField(
  input: HTMLInputElement,
  error: HTMLElement | undefined,
  clean: (value: string) => string,
  apply: (changes: ConfigChanges, value: string) => void,
  currentValue: (config: PublicConfig) => string,
): void {
  const commit = () => {
    if (!current) return;
    const typed = input.value.trim();
    const cleaned = clean(typed);
    const invalid = typed !== "" && cleaned === "";
    input.setAttribute("aria-invalid", String(invalid));
    if (error) error.hidden = !invalid;
    if (invalid || cleaned === currentValue(current)) return;
    void save((changes) => apply(changes, cleaned));
  };
  input.addEventListener("change", commit);
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter") input.blur();
  });
}

textField(
  twitchChannel,
  twitchChannelError,
  cleanTwitchChannel,
  (c, v) => (c.platforms.twitch.channel = v),
  (c) => c.platforms.twitch.channel,
);

textField(
  tiktokUsername,
  tiktokUsernameError,
  cleanTiktokUsername,
  (c, v) => (c.platforms.tiktok.username = v),
  (c) => c.platforms.tiktok.username,
);

textField(
  mentions,
  undefined,
  (v) => v.split(",").map((m) => m.trim().replace(/^@/, "")).filter(Boolean).join(", "),
  (c, v) => (c.tags.mentions = v ? v.split(", ") : []),
  (c) => c.tags.mentions.join(", "),
);

// La clave nunca vuelve del servidor: tras guardarla se vacía el campo.
eulerKey.addEventListener("change", () => {
  const key = eulerKey.value.trim();
  if (!key) return;
  eulerKey.value = "";
  void save((changes) => (changes.newEulerKey = key));
});
eulerKey.addEventListener("keydown", (event) => {
  if (event.key === "Enter") eulerKey.blur();
});

clearKey.addEventListener("click", () => {
  void save((changes) => (changes.newEulerKey = ""));
});

// ---------- Dock de OBS ----------

dockUrl.value = `${location.origin}/chat`;

$("copy-dock").addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(dockUrl.value);
    showToast("Dirección copiada");
  } catch {
    dockUrl.select();
    showToast("Selecciónala y cópiala con Ctrl+C", "error");
  }
});

// ---------- Integración con el resto de la interfaz ----------

/** Registra qué hacer cada vez que llega una configuración nueva (aplicar preferencias al chat). */
export function onChange(callback: (config: PublicConfig) => void): void {
  onConfigChange = callback;
}

export function setVersion(version: string): void {
  $("version").textContent = `v${version}`;
}
