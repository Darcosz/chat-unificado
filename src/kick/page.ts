// Página del chat de Kick abierta en un navegador real. Kick protege sus datos con Cloudflare
// y no responde a peticiones que no vengan de un navegador, así que el chat emergente se abre
// en una ventana oculta de Electron (src/desktop/kick-page.ts) y se leen los mensajes que la
// propia página recibe por su WebSocket. Con Node a secas (npm run server) no hay navegador:
// el conector avisa de que Kick solo funciona en la app de escritorio.

export interface KickPageHandlers {
  /** La página abrió su WebSocket de tiempo real (también cuando ella misma se reconecta). */
  socketOpened(): void;
  /** Contenido de un mensaje recibido por ese WebSocket. */
  frame(payload: string): void;
  /** Se cerró el WebSocket. Normalmente la página lo vuelve a abrir sola. */
  socketClosed(): void;
  /** Kick pide comprobar que es una persona (true) o ya se completó la comprobación (false). */
  challenge(active: boolean): void;
  /** La página no se pudo cargar (sin internet, Kick caído...). */
  loadFailed(reason: string): void;
}

export interface KickPage {
  reload(): void;
  close(): void;
}

export type KickPageOpener = (channel: string, handlers: KickPageHandlers) => KickPage;

let opener: KickPageOpener | undefined;

/** La app de escritorio registra aquí cómo abrir la página. */
export function setKickPageOpener(value: KickPageOpener): void {
  opener = value;
}

export function kickPageOpener(): KickPageOpener | undefined {
  return opener;
}
