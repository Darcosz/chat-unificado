// Inicio de sesión con Twitch por Device Code (flujo para apps públicas: no hay secreto).
// Guarda la sesión en el disco, renueva el token antes de que caduque y lo valida cada hora,
// como pide Twitch a las apps que usan tokens de usuario.

import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { setTimeout as sleep } from "node:timers/promises";
import type { TwitchLoginFlow } from "../core/protocol.ts";
import { deleteTwitchSession, loadTwitchSession, saveTwitchSession, type TwitchSession } from "../storage.ts";

/** Permisos que pide la app: seguidores, suscripciones, bits y canjes de puntos. */
export const TWITCH_SCOPES = ["moderator:read:followers", "channel:read:subscriptions", "bits:read", "channel:read:redemptions"];

const ID_URL = "https://id.twitch.tv/oauth2";
const HELIX_URL = "https://api.twitch.tv/helix";
/** Se renueva el token si le quedan menos de 5 minutos. */
const REFRESH_MARGIN = 5 * 60 * 1000;
const VALIDATE_EVERY = 60 * 60 * 1000;

type AuthEvents = {
  /** Cambió la sesión o el paso del inicio de sesión. */
  change: [];
};

interface TokenResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  scope?: string[];
}

export class TwitchAuth extends EventEmitter<AuthEvents> {
  readonly clientId: string | undefined;

  #session: TwitchSession | undefined;
  #flow: TwitchLoginFlow = { state: "idle" };
  #flowAbort: AbortController | undefined;
  #refreshing: Promise<string> | undefined;
  #validateTimer: NodeJS.Timeout | undefined;

  constructor(clientId: string | undefined) {
    super();
    this.clientId = clientId?.trim() || undefined;
  }

  /** Carga la sesión guardada y la valida. */
  async init(): Promise<void> {
    this.#session = await loadTwitchSession();
    this.#validateTimer = setInterval(() => void this.#validate(), VALIDATE_EVERY);
    this.#validateTimer.unref();
    if (this.#session) await this.#validate();
  }

  get available(): boolean {
    return this.clientId !== undefined;
  }

  /** Datos públicos de la cuenta (sin tokens). */
  get account(): Pick<TwitchSession, "userId" | "login" | "displayName"> | undefined {
    if (!this.#session) return undefined;
    const { userId, login, displayName } = this.#session;
    return { userId, login, displayName };
  }

  get flow(): TwitchLoginFlow {
    return this.#flow;
  }

  // ---------- Inicio de sesión ----------

  async startLogin(): Promise<void> {
    if (!this.clientId) throw new Error("Falta TWITCH_CLIENT_ID.");
    this.cancelLogin();

    const response = await postForm(`${ID_URL}/device`, { client_id: this.clientId, scopes: TWITCH_SCOPES.join(" ") });
    if (!response.ok) {
      this.#setFlow({ state: "error", message: `Twitch rechazó la petición: ${await errorMessage(response)}` });
      return;
    }
    const data = (await response.json()) as { device_code: string; user_code: string; verification_uri: string; interval: number; expires_in: number };

    const abort = new AbortController();
    this.#flowAbort = abort;
    this.#setFlow({ state: "waiting", userCode: data.user_code, verificationUri: data.verification_uri });
    openInBrowser(data.verification_uri);
    void this.#waitForAuthorization(data, abort.signal);
  }

  cancelLogin(): void {
    this.#flowAbort?.abort();
    this.#flowAbort = undefined;
    if (this.#flow.state !== "idle") this.#setFlow({ state: "idle" });
  }

  /** Vuelve a abrir la página de autorización si el usuario la cerró. */
  openLoginPage(): void {
    if (this.#flow.state === "waiting") openInBrowser(this.#flow.verificationUri);
  }

  async #waitForAuthorization(
    data: { device_code: string; interval: number; expires_in: number },
    signal: AbortSignal,
  ): Promise<void> {
    const deadline = Date.now() + data.expires_in * 1000;
    let interval = Math.max(1, data.interval) * 1000;

    try {
      while (Date.now() < deadline) {
        await sleep(interval, undefined, { signal });
        const response = await postForm(`${ID_URL}/token`, {
          client_id: this.clientId!,
          scopes: TWITCH_SCOPES.join(" "),
          device_code: data.device_code,
          grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        });
        if (signal.aborted) return;

        if (response.ok) {
          await this.#startSession((await response.json()) as TokenResponse);
          if (!signal.aborted) this.#setFlow({ state: "idle" });
          return;
        }

        const message = await errorMessage(response);
        if (message === "authorization_pending") continue;
        if (message === "slow_down") {
          interval += 5000;
          continue;
        }
        this.#setFlow({ state: "error", message: message === "access_denied" ? "Se canceló la autorización en Twitch." : `No se pudo iniciar sesión: ${message}` });
        return;
      }
      this.#setFlow({ state: "error", message: "El código caducó. Vuelve a intentarlo." });
    } catch (error) {
      if (signal.aborted) return;
      this.#setFlow({ state: "error", message: `No se pudo iniciar sesión: ${error instanceof Error ? error.message : String(error)}` });
    }
  }

  async #startSession(tokens: TokenResponse): Promise<void> {
    const validated = await this.#fetchValidate(tokens.access_token);
    if (!validated) throw new Error("Twitch no aceptó el token recibido.");

    const users = await fetch(`${HELIX_URL}/users?id=${encodeURIComponent(validated.user_id)}`, {
      headers: { Authorization: `Bearer ${tokens.access_token}`, "Client-Id": this.clientId! },
    });
    const user = users.ok ? ((await users.json()) as { data: { display_name: string }[] }).data[0] : undefined;

    this.#session = {
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token,
      expiresAt: Date.now() + tokens.expires_in * 1000,
      userId: validated.user_id,
      login: validated.login,
      displayName: user?.display_name ?? validated.login,
      scopes: validated.scopes,
    };
    await saveTwitchSession(this.#session);
    this.emit("change");
  }

  async logout(): Promise<void> {
    this.cancelLogin();
    const session = this.#session;
    this.#session = undefined;
    await deleteTwitchSession();
    this.emit("change");
    // Se revoca el token en Twitch; si falla no pasa nada, ya no se guarda en ningún lado.
    if (session && this.clientId) {
      await postForm(`${ID_URL}/revoke`, { client_id: this.clientId, token: session.accessToken }).catch(() => {});
    }
  }

  // ---------- Tokens ----------

  /** Token válido para la API; lo renueva si está por caducar. */
  async getAccessToken(): Promise<string> {
    if (!this.#session) throw new Error("No hay sesión de Twitch.");
    if (this.#session.expiresAt - Date.now() < REFRESH_MARGIN) return this.refresh();
    return this.#session.accessToken;
  }

  /** Renueva el token. Si hay varias llamadas a la vez, se hace una sola renovación. */
  refresh(): Promise<string> {
    this.#refreshing ??= this.#doRefresh().finally(() => (this.#refreshing = undefined));
    return this.#refreshing;
  }

  async #doRefresh(): Promise<string> {
    const session = this.#session;
    if (!session || !this.clientId) throw new Error("No hay sesión de Twitch.");

    const response = await postForm(`${ID_URL}/token`, {
      client_id: this.clientId,
      grant_type: "refresh_token",
      refresh_token: session.refreshToken,
    });

    if (!response.ok) {
      // 400/401: el refresh token ya no sirve (revocado o caducado). Hay que volver a iniciar sesión.
      if (response.status === 400 || response.status === 401) await this.#expireSession();
      throw new Error(`No se pudo renovar el token de Twitch: ${await errorMessage(response)}`);
    }

    const tokens = (await response.json()) as TokenResponse;
    // En apps públicas cada refresh token se usa una sola vez: hay que guardar el nuevo.
    this.#session = { ...session, accessToken: tokens.access_token, refreshToken: tokens.refresh_token, expiresAt: Date.now() + tokens.expires_in * 1000 };
    await saveTwitchSession(this.#session);
    return tokens.access_token;
  }

  async #expireSession(): Promise<void> {
    this.#session = undefined;
    await deleteTwitchSession();
    this.#setFlow({ state: "error", message: "La sesión de Twitch caducó. Vuelve a iniciar sesión." });
  }

  async #validate(): Promise<void> {
    if (!this.#session) return;
    try {
      if (!(await this.#fetchValidate(this.#session.accessToken))) await this.refresh();
    } catch (error) {
      // Sin internet no se puede validar; se reintenta en la siguiente vuelta.
      console.error("No se pudo validar la sesión de Twitch:", error instanceof Error ? error.message : error);
    }
  }

  /** Devuelve los datos del token, o undefined si Twitch dice que no es válido (401). */
  async #fetchValidate(token: string): Promise<{ user_id: string; login: string; scopes: string[] } | undefined> {
    const response = await fetch(`${ID_URL}/validate`, { headers: { Authorization: `OAuth ${token}` } });
    if (response.status === 401) return undefined;
    if (!response.ok) throw new Error(await errorMessage(response));
    return (await response.json()) as { user_id: string; login: string; scopes: string[] };
  }

  #setFlow(flow: TwitchLoginFlow): void {
    this.#flow = flow;
    this.emit("change");
  }
}

function postForm(url: string, fields: Record<string, string>): Promise<Response> {
  return fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(fields),
  });
}

/** Twitch responde los errores como { status, message }. */
async function errorMessage(response: Response): Promise<string> {
  const text = await response.text();
  try {
    return String((JSON.parse(text) as { message?: unknown }).message ?? text);
  } catch {
    return text || `HTTP ${response.status}`;
  }
}

/** Abre la página de Twitch en el navegador del sistema. Solo acepta direcciones de Twitch. */
function openInBrowser(url: string): void {
  if (!/^https:\/\/(www|id)\.twitch\.tv\//.test(url)) return;
  // rundll32 abre la URL tal cual; con "cmd /c start" el & de la URL se interpretaría como comando.
  const [command, args] =
    process.platform === "win32" ? ["rundll32", ["url.dll,FileProtocolHandler", url]] : process.platform === "darwin" ? ["open", [url]] : ["xdg-open", [url]];
  spawn(command, args, { detached: true, stdio: "ignore" }).on("error", () => {}).unref();
}
