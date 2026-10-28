// Conector de TikTok con tiktok-live-connector: lee el live como un espectador (no hay login,
// TikTok solo da acceso oficial a socios) firmando la conexión con la clave de Euler Stream.
// Recibe chat, follows, regalos (agrupando los combos) y compartidos.
// Solo funciona mientras la cuenta está en vivo: si no lo está, espera y vuelve a probar,
// cada vez con más calma para no gastar el límite diario de Euler.

import { ControlEvent, PremiumFeatureError, SignatureRateLimitError, TikTokLiveConnection, UserOfflineError, WebcastEvent } from "tiktok-live-connector";
import { Connector } from "../core/connector.ts";
import type { ChatEvent, EventType, User } from "../core/event.ts";

/** Reintentos mientras la cuenta no está en vivo: de 30 s hasta 5 min. */
const OFFLINE_RETRY = { min: 30_000, max: 5 * 60_000 };
/** Reintentos tras un fallo de conexión: de 5 s hasta 5 min. */
const ERROR_RETRY = { min: 5_000, max: 5 * 60_000 };
/** Si se acaba el límite de Euler, se espera más antes de volver a intentar. */
const RATE_LIMIT_RETRY = 10 * 60_000;
/** Si un combo no avisa que terminó, se muestra igual tras este tiempo sin novedades. */
const COMBO_TIMEOUT = 8_000;

/** Lo que nos interesa de un usuario de TikTok (los tipos de la librería traen muchísimo más). */
interface TikTokUser {
  id?: string;
  nickname?: string;
  displayId?: string;
  avatarThumb?: { urlList?: string[] };
}

/** Datos comunes de cada mensaje: id y hora (en milisegundos, como texto). */
interface TikTokCommon {
  msgId?: string;
  createTime?: string;
}

interface TikTokGift {
  giftId: string;
  groupId: string;
  repeatCount: number;
  repeatEnd: number;
  user?: TikTokUser;
  common?: TikTokCommon;
  gift?: { name?: string; type?: number; combo?: boolean };
}

/**
 * Los métodos de eventos de la conexión. La librería los declara con `typed-emitter`, que
 * TypeScript no resuelve con "module": "nodenext"; en ejecución existen igual (es un EventEmitter).
 */
interface TikTokEvents {
  on(event: WebcastEvent.CHAT, listener: (data: { user?: TikTokUser; common?: TikTokCommon; content: string }) => void): unknown;
  on(event: WebcastEvent.FOLLOW | WebcastEvent.SHARE, listener: (data: { user?: TikTokUser; common?: TikTokCommon }) => void): unknown;
  on(
    event: WebcastEvent.SOCIAL,
    listener: (data: { user?: TikTokUser; common?: TikTokCommon & { displayText?: { key?: string } } }) => void,
  ): unknown;
  on(event: WebcastEvent.GIFT, listener: (data: TikTokGift) => void): unknown;
  on(event: WebcastEvent.STREAM_END, listener: () => void): unknown;
  on(event: ControlEvent.DISCONNECTED, listener: (data: { code: number; reason?: string }) => void): unknown;
  removeAllListeners(): unknown;
}

function events(connection: TikTokLiveConnection): TikTokEvents {
  return connection as unknown as TikTokEvents;
}

interface PendingCombo {
  event: ChatEvent;
  timer: NodeJS.Timeout;
}

export class TikTokConnector extends Connector {
  readonly platform = "tiktok";
  readonly username: string;

  readonly #eulerKey: string;
  #connection: TikTokLiveConnection | undefined;
  #closing = false;
  #attempts = 0;
  #retryTimer: NodeJS.Timeout | undefined;
  /** Combos de regalos en curso, por usuario + regalo + grupo. */
  readonly #combos = new Map<string, PendingCombo>();

  constructor(username: string, eulerKey: string) {
    super();
    this.username = username;
    this.#eulerKey = eulerKey;
  }

  async connect(): Promise<void> {
    this.#closing = false;
    if (!this.#eulerKey) {
      this.setStatus("error", "Falta la clave de Euler Stream");
      return;
    }
    await this.#open();
  }

  async disconnect(): Promise<void> {
    this.#closing = true;
    clearTimeout(this.#retryTimer);
    this.#flushCombos();
    const connection = this.#connection;
    this.#connection = undefined;
    if (connection) events(connection).removeAllListeners();
    await connection?.disconnect().catch(() => {});
    this.setStatus("disconnected");
  }

  async #open(): Promise<void> {
    this.setStatus(this.#attempts > 0 ? "reconnecting" : "connecting");

    const connection = new TikTokLiveConnection(this.username, {
      signApiKey: this.#eulerKey,
      // Sin el historial inicial: son mensajes viejos que se repetirían en cada reconexión.
      processInitialData: false,
      // enableExtendedGiftInfo se deja apagado: pide la lista de regalos a Euler y eso es del
      // plan de pago. El nombre del regalo ya viene en cada evento (gift.name).
    });
    this.#connection = connection;
    const current = () => connection === this.#connection && !this.#closing;

    events(connection).on(WebcastEvent.CHAT, (data) => {
      if (!current()) return;
      const event = this.#base("chat", data.user, data.common);
      event.text = data.content;
      this.emit("event", event);
    });
    events(connection).on(WebcastEvent.FOLLOW, (data) => {
      if (current()) this.emit("event", this.#base("follow", data.user, data.common));
    });
    events(connection).on(WebcastEvent.SHARE, (data) => {
      if (current()) this.emit("event", this.#base("share", data.user, data.common));
    });
    // Los reposts ("X reposteó") llegan como "social" porque su clave no dice "share";
    // para el streamer son lo mismo que compartir, así que van como compartido con detalle.
    events(connection).on(WebcastEvent.SOCIAL, (data) => {
      if (!current() || !data.common?.displayText?.key?.includes("repost")) return;
      const event = this.#base("share", data.user, data.common);
      event.detail = "repost";
      this.emit("event", event);
    });
    events(connection).on(WebcastEvent.GIFT, (data) => {
      if (current()) this.#onGift(data);
    });
    events(connection).on(WebcastEvent.STREAM_END, () => {
      if (!current()) return;
      this.#flushCombos();
      this.#retry(`El live de @${this.username} terminó`, "disconnected", OFFLINE_RETRY.min);
    });
    events(connection).on(ControlEvent.DISCONNECTED, ({ reason }) => {
      if (!current()) return;
      this.#flushCombos();
      this.#retry(reason || "Se perdió la conexión", "reconnecting", this.#backoff(ERROR_RETRY));
    });

    try {
      await connection.connect();
      if (!current()) return;
      this.#attempts = 0;
      this.setStatus("connected");
    } catch (error) {
      if (!current()) return;
      if (error instanceof UserOfflineError) {
        this.#retry(`@${this.username} no está en vivo`, "disconnected", this.#backoff(OFFLINE_RETRY));
      } else if (error instanceof SignatureRateLimitError) {
        this.#retry("Se alcanzó el límite diario de Euler Stream", "error", RATE_LIMIT_RETRY);
      } else if (error instanceof PremiumFeatureError || /business plan/i.test(String((error as Error)?.message))) {
        // Reintentar rápido no lo arreglaría: es una función del plan de pago de Euler.
        this.#retry("Euler Stream pide un plan de pago para esta conexión", "error", RATE_LIMIT_RETRY);
      } else {
        this.#retry(error instanceof Error ? error.message : String(error), "reconnecting", this.#backoff(ERROR_RETRY));
      }
    }
  }

  /** Espera creciente: min, 2×min, 4×min… hasta max. */
  #backoff({ min, max }: { min: number; max: number }): number {
    return Math.min(max, min * 2 ** this.#attempts++);
  }

  /** Cierra la conexión actual y programa otro intento. */
  #retry(reason: string, status: "disconnected" | "reconnecting" | "error", wait: number): void {
    const connection = this.#connection;
    this.#connection = undefined;
    if (connection) events(connection).removeAllListeners();
    void connection?.disconnect().catch(() => {});

    this.setStatus(status, reason);
    clearTimeout(this.#retryTimer);
    this.#retryTimer = setTimeout(() => {
      if (!this.#closing) void this.#open();
    }, wait);
  }

  // ---------- Regalos ----------

  /**
   * Los regalos de combo (por ejemplo, 30 rosas seguidas) llegan como muchos eventos con
   * repeatCount creciente y uno final con repeatEnd. Se muestra solo el total al terminar.
   */
  #onGift(data: TikTokGift): void {
    const event = this.#base("gift", data.user, data.common);
    event.detail = data.gift?.name || "un regalo";
    event.amount = Math.max(1, Number(data.repeatCount) || 1);

    const isCombo = data.gift?.combo === true || data.gift?.type === 1;
    if (!isCombo) {
      this.emit("event", event);
      return;
    }

    const key = `${event.user.id}:${data.giftId}:${data.groupId}`;
    const pending = this.#combos.get(key);
    if (pending) clearTimeout(pending.timer);

    if (data.repeatEnd) {
      this.#combos.delete(key);
      this.emit("event", event);
      return;
    }

    // Combo en curso: se espera al final; si nunca llega, se muestra lo que haya tras un rato.
    this.#combos.set(key, {
      event,
      timer: setTimeout(() => {
        this.#combos.delete(key);
        this.emit("event", event);
      }, COMBO_TIMEOUT),
    });
  }

  /** Muestra los combos que quedaron a medias (al desconectar o terminar el live). */
  #flushCombos(): void {
    for (const { event, timer } of this.#combos.values()) {
      clearTimeout(timer);
      this.emit("event", event);
    }
    this.#combos.clear();
  }

  // ---------- Traducción ----------

  #base(type: EventType, user: TikTokUser | undefined, common: TikTokCommon | undefined): ChatEvent {
    const createdAt = Number(common?.createTime);
    return {
      id: common?.msgId ? `tiktok-${common.msgId}` : `tiktok-${Date.now()}-${Math.random()}`,
      platform: "tiktok",
      type,
      user: translateUser(user),
      flags: { firstTime: false, question: false },
      timestamp: (Number.isFinite(createdAt) && createdAt > 0 ? new Date(createdAt) : new Date()).toISOString(),
    };
  }
}

function translateUser(user: TikTokUser | undefined): User {
  const avatar = user?.avatarThumb?.urlList?.[0];
  return {
    id: String(user?.id ?? ""),
    name: user?.nickname || user?.displayId || "anónimo",
    ...(user?.displayId ? { login: user.displayId } : {}),
    ...(avatar ? { avatar } : {}),
  };
}
