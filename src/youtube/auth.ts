// Inicio de sesión con Google para YouTube: cliente de tipo "App de escritorio" con redirección
// a la propia app (http://127.0.0.1:<puerto>) y PKCE, el flujo que recomienda Google para apps
// instaladas. Pide solo youtube.readonly. Guarda la sesión, renueva el token antes de que caduque
// y permite desconectar (revocando el token).

import { createHash, randomBytes } from "node:crypto";
import { EventEmitter } from "node:events";
import type { YouTubeLoginFlow } from "../core/protocol.ts";
import { openInBrowser } from "../open-url.ts";
import { deleteYouTubeSession, loadYouTubeSession, saveYouTubeSession, type YouTubeSession } from "../storage.ts";

const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const REVOKE_URL = "https://oauth2.googleapis.com/revoke";
const CHANNELS_URL = "https://www.googleapis.com/youtube/v3/channels";
const SCOPE = "https://www.googleapis.com/auth/youtube.readonly";
const GOOGLE_HOSTS = ["accounts.google.com"];
/** Se renueva el token si le quedan menos de 5 minutos. */
const REFRESH_MARGIN = 5 * 60 * 1000;
/** Si en 10 minutos no se autoriza, se cancela el intento. */
const LOGIN_TIMEOUT = 10 * 60 * 1000;

type AuthEvents = {
  /** Cambió la sesión o el paso del inicio de sesión. */
  change: [];
};

interface PendingLogin {
  state: string;
  verifier: string;
  url: string;
  timer: NodeJS.Timeout;
}

/** Texto aleatorio seguro para URLs (para state y el verificador de PKCE). */
function randomToken(): string {
  return randomBytes(32).toString("base64url");
}

export class GoogleAuth extends EventEmitter<AuthEvents> {
  readonly #clientId: string | undefined;
  readonly #clientSecret: string | undefined;
  readonly #redirectUri: string;

  #session: YouTubeSession | undefined;
  #flow: YouTubeLoginFlow = { state: "idle" };
  #pending: PendingLogin | undefined;
  #refreshing: Promise<string> | undefined;

  constructor(options: { clientId: string | undefined; clientSecret: string | undefined; redirectUri: string }) {
    super();
    this.#clientId = options.clientId?.trim() || undefined;
    this.#clientSecret = options.clientSecret?.trim() || undefined;
    this.#redirectUri = options.redirectUri;
  }

  async init(): Promise<void> {
    this.#session = await loadYouTubeSession();
  }

  get available(): boolean {
    return this.#clientId !== undefined && this.#clientSecret !== undefined;
  }

  /** Datos públicos del canal (sin tokens). */
  get account(): { channelId: string; title: string } | undefined {
    return this.#session ? { channelId: this.#session.channelId, title: this.#session.title } : undefined;
  }

  get flow(): YouTubeLoginFlow {
    return this.#flow;
  }

  // ---------- Inicio de sesión ----------

  startLogin(): void {
    if (!this.available) throw new Error("Faltan GOOGLE_CLIENT_ID y GOOGLE_CLIENT_SECRET.");
    this.cancelLogin();

    const verifier = randomToken();
    const state = randomToken();
    const params = new URLSearchParams({
      client_id: this.#clientId!,
      redirect_uri: this.#redirectUri,
      response_type: "code",
      scope: SCOPE,
      state,
      code_challenge: createHash("sha256").update(verifier).digest("base64url"),
      code_challenge_method: "S256",
      // offline + consent: así Google entrega un refresh token y la sesión dura.
      access_type: "offline",
      prompt: "consent",
    });
    const url = `${AUTH_URL}?${params}`;

    const timer = setTimeout(() => {
      this.#pending = undefined;
      this.#setFlow({ state: "error", message: "Se acabó el tiempo para autorizar. Vuelve a intentarlo." });
    }, LOGIN_TIMEOUT);
    timer.unref();

    this.#pending = { state, verifier, url, timer };
    this.#setFlow({ state: "waiting" });
    openInBrowser(url, GOOGLE_HOSTS);
  }

  cancelLogin(): void {
    if (this.#pending) clearTimeout(this.#pending.timer);
    this.#pending = undefined;
    if (this.#flow.state !== "idle") this.#setFlow({ state: "idle" });
  }

  openLoginPage(): void {
    if (this.#pending) openInBrowser(this.#pending.url, GOOGLE_HOSTS);
  }

  /**
   * Atiende la redirección de Google (la abre el navegador del usuario).
   * Devuelve el texto que se muestra en esa pestaña.
   */
  async handleCallback(params: URLSearchParams): Promise<{ ok: boolean; message: string }> {
    const pending = this.#pending;
    // Sin un inicio de sesión en curso o con otro state, la petición no viene de nuestro flujo.
    if (!pending || params.get("state") !== pending.state) {
      return { ok: false, message: "Este enlace no corresponde a un inicio de sesión en curso. Vuelve a intentarlo desde la app." };
    }
    clearTimeout(pending.timer);
    this.#pending = undefined;

    const error = params.get("error");
    if (error) {
      const message = error === "access_denied" ? "Se canceló la autorización en Google." : `Google respondió con un error: ${error}`;
      this.#setFlow({ state: "error", message });
      return { ok: false, message };
    }

    try {
      const tokens = await this.#requestTokens({
        grant_type: "authorization_code",
        code: params.get("code") ?? "",
        code_verifier: pending.verifier,
        redirect_uri: this.#redirectUri,
      });
      if (!tokens.refresh_token) throw new Error("Google no entregó un refresh token.");

      const channel = await this.#fetchOwnChannel(tokens.access_token);
      this.#session = {
        accessToken: tokens.access_token,
        refreshToken: tokens.refresh_token,
        expiresAt: Date.now() + tokens.expires_in * 1000,
        channelId: channel.id,
        title: channel.title,
      };
      await saveYouTubeSession(this.#session);
      this.#setFlow({ state: "idle" });
      return { ok: true, message: `Listo: se conectó el canal «${channel.title}». Ya puedes cerrar esta pestaña.` };
    } catch (error) {
      const message = `No se pudo completar el inicio de sesión: ${error instanceof Error ? error.message : String(error)}`;
      this.#setFlow({ state: "error", message });
      return { ok: false, message };
    }
  }

  async logout(): Promise<void> {
    this.cancelLogin();
    const session = this.#session;
    this.#session = undefined;
    await deleteYouTubeSession();
    this.emit("change");
    // Se revoca en Google; si falla no pasa nada, ya no se guarda en ningún lado.
    if (session) {
      await fetch(REVOKE_URL, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ token: session.refreshToken }),
      }).catch(() => {});
    }
  }

  // ---------- Tokens ----------

  /** Token válido para la API; lo renueva si está por caducar. */
  async getAccessToken(): Promise<string> {
    if (!this.#session) throw new Error("No hay sesión de YouTube.");
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
    if (!session) throw new Error("No hay sesión de YouTube.");
    try {
      const tokens = await this.#requestTokens({ grant_type: "refresh_token", refresh_token: session.refreshToken });
      // Google no cambia el refresh token al renovar (a veces manda uno nuevo; si viene, se usa).
      this.#session = {
        ...session,
        accessToken: tokens.access_token,
        refreshToken: tokens.refresh_token ?? session.refreshToken,
        expiresAt: Date.now() + tokens.expires_in * 1000,
      };
      await saveYouTubeSession(this.#session);
      return tokens.access_token;
    } catch (error) {
      // invalid_grant: el permiso se revocó o caducó. Hay que volver a iniciar sesión.
      if (error instanceof Error && error.message.includes("invalid_grant")) {
        this.#session = undefined;
        await deleteYouTubeSession();
        this.#setFlow({ state: "error", message: "La sesión de YouTube caducó. Vuelve a conectar tu cuenta." });
      }
      throw error;
    }
  }

  async #requestTokens(fields: Record<string, string>): Promise<{ access_token: string; refresh_token?: string; expires_in: number }> {
    const response = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ client_id: this.#clientId!, client_secret: this.#clientSecret!, ...fields }),
    });
    const data = (await response.json().catch(() => ({}))) as Record<string, unknown>;
    if (!response.ok) throw new Error(String(data.error ?? `HTTP ${response.status}`));
    return data as unknown as { access_token: string; refresh_token?: string; expires_in: number };
  }

  /** Canal de la cuenta que autorizó (cuesta 1 unidad de cuota). */
  async #fetchOwnChannel(accessToken: string): Promise<{ id: string; title: string }> {
    const response = await fetch(`${CHANNELS_URL}?part=snippet&mine=true`, { headers: { Authorization: `Bearer ${accessToken}` } });
    if (!response.ok) throw new Error(`No se pudo leer tu canal (HTTP ${response.status}).`);
    const data = (await response.json()) as { items?: { id: string; snippet?: { title?: string } }[] };
    const channel = data.items?.[0];
    if (!channel) throw new Error("La cuenta de Google que autorizaste no tiene canal de YouTube.");
    return { id: channel.id, title: channel.snippet?.title ?? channel.id };
  }

  #setFlow(flow: YouTubeLoginFlow): void {
    this.#flow = flow;
    this.emit("change");
  }
}
