// Abre una página en el navegador del sistema (para los inicios de sesión).
// Solo acepta direcciones https de los dominios indicados, por si algún día llegara una URL
// manipulada: así nunca se abre otra cosa.

import { spawn } from "node:child_process";

/** Quién abre las URLs. En la app de escritorio, Electron lo cambia por shell.openExternal. */
let opener: ((url: string) => void) | undefined;

export function setUrlOpener(open: (url: string) => void): void {
  opener = open;
}

export function openInBrowser(url: string, allowedHosts: readonly string[]): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return;
  }
  if (parsed.protocol !== "https:" || !allowedHosts.includes(parsed.hostname)) return;
  if (opener) {
    opener(url);
    return;
  }

  // rundll32 abre la URL tal cual; con "cmd /c start" el & de la URL se interpretaría como comando.
  const [command, args] =
    process.platform === "win32" ? ["rundll32", ["url.dll,FileProtocolHandler", url]] : process.platform === "darwin" ? ["open", [url]] : ["xdg-open", [url]];
  spawn(command, args, { detached: true, stdio: "ignore" }).on("error", () => {}).unref();
}
