// App de escritorio (Electron): arranca el backend dentro del propio proceso principal (sin un
// Node aparte, para gastar menos memoria) y muestra la interfaz de localhost en una ventana
// flotante, con icono en la bandeja del sistema. Aplica las preferencias de la pantalla de
// configuración: siempre encima, opacidad e iniciar con Windows.

import { app, BrowserWindow, dialog, Menu, nativeImage, safeStorage, screen, shell, Tray } from "electron";
import electronUpdater from "electron-updater";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { startApp, type RunningApp } from "../app.ts";
import type { Config } from "../core/config.ts";
import { setKickPageOpener } from "../kick/page.ts";
import { setUrlOpener } from "../open-url.ts";
import { APP_ROOT } from "../paths.ts";
import { DATA_DIR, setSecretCodec } from "../storage.ts";
import { openKickPage } from "./kick-page.ts";

const PORT = Number(process.env.PORT) || 4848;
const WINDOW_FILE = join(DATA_DIR, "window.json");
const ICON = join(APP_ROOT, "assets", "icon.png");

interface Bounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

let window: BrowserWindow | undefined;
let tray: Tray | undefined;
let running: RunningApp | undefined;
let quitting = false;

// Una sola copia: si se abre otra, se enfoca la ventana de la primera.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", showWindow);
  app.whenReady().then(start).catch(async (error: unknown) => {
    dialog.showErrorBox("Chat Unificado", `No se pudo iniciar la app:\n\n${error instanceof Error ? error.message : String(error)}`);
    app.quit();
  });
}

async function start(): Promise<void> {
  // Secretos (sesiones de Twitch y YouTube, clave de Euler) cifrados con la protección de Windows.
  if (await safeStorage.isAsyncEncryptionAvailable()) {
    setSecretCodec({
      encrypt: async (text) => (await safeStorage.encryptStringAsync(text)).toString("base64"),
      decrypt: async (text) => (await safeStorage.decryptStringAsync(Buffer.from(text, "base64"))).result,
    });
  }
  // Los inicios de sesión se abren en el navegador normal del usuario.
  setUrlOpener((url) => void shell.openExternal(url));
  // Kick se lee desde su chat emergente, en una ventana oculta (ver kick-page.ts).
  setKickPageOpener(openKickPage);

  try {
    running = await startApp({ port: PORT, demoMode: process.argv.includes("--demo") });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    dialog.showErrorBox("Chat Unificado", message.includes("ya está en uso") ? "La app ya está abierta (el puerto 4848 está en uso)." : message);
    app.quit();
    return;
  }

  Menu.setApplicationMenu(null);
  await createWindow();
  createTray();
  applyConfig(running.config());
  running.onConfigChange(applyConfig);
  checkForUpdates();
}

// ---------- Ventana ----------

async function createWindow(): Promise<void> {
  const bounds = await loadBounds();
  window = new BrowserWindow({
    ...(bounds ?? { width: 860, height: 820 }),
    minWidth: 360,
    minHeight: 420,
    title: "Chat Unificado",
    icon: ICON,
    backgroundColor: "#0f1115",
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  });

  // La ventana solo muestra la app local: cualquier otra dirección se abre fuera (si es web) o se bloquea.
  const isLocal = (url: string) => url.startsWith(`http://localhost:${PORT}/`) || url.startsWith(`http://127.0.0.1:${PORT}/`);
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("https://")) void shell.openExternal(url);
    return { action: "deny" };
  });
  window.webContents.on("will-navigate", (event, url) => {
    if (!isLocal(url)) event.preventDefault();
  });

  window.once("ready-to-show", () => window?.show());
  window.on("close", () => void saveBounds());
  window.on("closed", () => {
    window = undefined;
    // Cerrar la ventana cierra la app.
    if (!quitting) app.quit();
  });

  await window.loadURL(`http://localhost:${PORT}/`);
}

function showWindow(): void {
  if (!window) return;
  if (window.isMinimized()) window.restore();
  window.show();
  window.focus();
}

/** Posición y tamaño de la última vez, si siguen dentro de alguna pantalla conectada. */
async function loadBounds(): Promise<Bounds | undefined> {
  try {
    const saved = JSON.parse(await readFile(WINDOW_FILE, "utf8")) as Bounds;
    const visible = screen.getAllDisplays().some(({ workArea: a }) => saved.x >= a.x - 50 && saved.y >= a.y - 50 && saved.x < a.x + a.width - 100 && saved.y < a.y + a.height - 100);
    return visible ? saved : undefined;
  } catch {
    return undefined;
  }
}

async function saveBounds(): Promise<void> {
  if (!window || window.isMinimized() || window.isMaximized()) return;
  await writeFile(WINDOW_FILE, JSON.stringify(window.getBounds())).catch(() => {});
}

// ---------- Bandeja ----------

function createTray(): void {
  tray = new Tray(nativeImage.createFromPath(ICON).resize({ width: 16, height: 16 }));
  tray.setToolTip("Chat Unificado");
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: "Mostrar", click: showWindow },
      { type: "separator" },
      { label: "Salir", click: () => app.quit() },
    ]),
  );
  tray.on("click", showWindow);
}

// ---------- Preferencias ----------

function applyConfig(config: Config): void {
  if (window) {
    // "floating" lo deja encima de las ventanas normales sin tapar menús del sistema.
    window.setAlwaysOnTop(config.window.alwaysOnTop, "floating");
    window.setOpacity(config.window.opacity);
  }
  // Solo en la app instalada: en desarrollo registraría electron.exe, no la app.
  if (app.isPackaged) {
    app.setLoginItemSettings({ openAtLogin: config.window.startWithWindows });
  }
}

// ---------- Actualizaciones ----------

function checkForUpdates(): void {
  if (!app.isPackaged || !running?.config().autoUpdate) return;
  // Busca una versión nueva en las releases de GitHub; si la hay, la descarga y la instala al cerrar.
  electronUpdater.autoUpdater.checkForUpdatesAndNotify().catch((error: unknown) => {
    console.error("No se pudo buscar actualizaciones:", error instanceof Error ? error.message : error);
  });
}

// ---------- Cierre ----------

app.on("before-quit", (event) => {
  if (quitting || !running) return;
  // Se cierra con calma: se desconectan las plataformas y se guardan los usuarios vistos.
  event.preventDefault();
  quitting = true;
  void saveBounds()
    .then(() => running?.stop())
    .catch(() => {})
    .finally(() => app.quit());
});

app.on("window-all-closed", () => {
  if (!quitting) app.quit();
});
