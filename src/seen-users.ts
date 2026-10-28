// Registro de usuarios que ya escribieron en el chat, para marcar NUEVO en las plataformas
// que no lo indican (TikTok). Se guarda en la PC y sobrevive a reiniciar la app.

import type { Platform } from "./core/event.ts";
import { loadSeenUsers, saveSeenUsers } from "./storage.ts";

/** Máximo de usuarios recordados por plataforma; al pasarse se olvidan los más antiguos. */
const MAX_PER_PLATFORM = 50_000;
/** Los cambios se guardan como mucho cada 30 segundos, no con cada mensaje. */
const SAVE_DELAY = 30_000;

export class SeenUsers {
  // Un Set conserva el orden de inserción: los primeros son los más antiguos.
  readonly #seen = new Map<string, Set<string>>();
  #saveTimer: NodeJS.Timeout | undefined;

  static async load(): Promise<SeenUsers> {
    const seenUsers = new SeenUsers();
    for (const [platform, ids] of Object.entries(await loadSeenUsers())) seenUsers.#seen.set(platform, new Set(ids));
    return seenUsers;
  }

  /** Apunta al usuario y devuelve true si es la primera vez que se le ve. */
  markSeen(platform: Platform, userId: string): boolean {
    if (!userId) return false;
    let ids = this.#seen.get(platform);
    if (!ids) this.#seen.set(platform, (ids = new Set()));
    if (ids.has(userId)) return false;

    ids.add(userId);
    if (ids.size > MAX_PER_PLATFORM) ids.delete(ids.values().next().value!);
    this.#scheduleSave();
    return true;
  }

  /** Guarda ya lo pendiente (al cerrar la app). */
  async flush(): Promise<void> {
    if (!this.#saveTimer) return;
    clearTimeout(this.#saveTimer);
    this.#saveTimer = undefined;
    await saveSeenUsers(Object.fromEntries([...this.#seen].map(([platform, ids]) => [platform, [...ids]])));
  }

  #scheduleSave(): void {
    if (this.#saveTimer) return;
    this.#saveTimer = setTimeout(() => {
      this.#saveTimer = undefined;
      void saveSeenUsers(Object.fromEntries([...this.#seen].map(([platform, ids]) => [platform, [...ids]])));
    }, SAVE_DELAY);
    // No retiene el cierre de la app; al cerrar se guarda con flush().
    this.#saveTimer.unref();
  }
}
