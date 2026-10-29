// Conector de YouTube: con la sesión de Google busca el directo activo del propio canal (API
// oficial, 1 unidad) y lee su chat por InnerTube (src/youtube/innertube.ts): las mismas peticiones
// que hace la página de YouTube, sin cuota y con ~1 s de retraso. Si InnerTube falla varias veces
// seguidas, se usa la API oficial durante un rato y luego se vuelve a probar.
//
// API oficial de respaldo: liveChatMessages.streamList (gRPC, conexión abierta de baja latencia).
// Recibe mensajes, Super Chats, Super Stickers, membresías nuevas, hitos de membresía,
// membresías regaladas y regalos.
//
// streamList es inestable: a veces YouTube lo rechaza con "overloaded" (código 14) sin importar
// cuánto se espere. En ese caso se pasa un rato a liveChatMessages.list (REST, estable) y luego
// se vuelve a probar el flujo. Los dos comparten nextPageToken, así que no se pierde ni se
// repite ningún mensaje al cambiar (comprobado con un directo real).
//
// Cuota (10,000 unidades al día): buscar el directo cuesta 1 unidad; abrir el flujo o consultar
// por REST, 5. Sin directo se busca cada 1-3 minutos.

import grpc from "@grpc/grpc-js";
import protoLoader from "@grpc/proto-loader";
import { fileURLToPath } from "node:url";
import { Connector } from "../core/connector.ts";
import type { ChatEvent, EventType } from "../core/event.ts";
import type { GoogleAuth } from "../youtube/auth.ts";
import type { YouTubeChatItem } from "../youtube/chat-item.ts";
import { InnerTubeChat } from "../youtube/innertube.ts";

const BROADCASTS_URL = "https://www.googleapis.com/youtube/v3/liveBroadcasts";
const MESSAGES_URL = "https://www.googleapis.com/youtube/v3/liveChat/messages";
const GRPC_TARGET = "youtube.googleapis.com:443";
const PROTO_FILE = fileURLToPath(new URL("../youtube/stream-list.proto", import.meta.url));

/** Sin directo activo: se vuelve a buscar de 1 a 3 minutos (1 unidad cada vez). */
const OFFLINE_RETRY = { min: 60_000, max: 3 * 60_000 };
/** Fallos de conexión: de 2 s a 1 min. */
const ERROR_RETRY = { min: 2_000, max: 60_000 };
/** Si se acaba la cuota diaria, se espera más. */
const QUOTA_RETRY = 30 * 60_000;
/**
 * YouTube cierra cada flujo a los ~10 s aunque haya chat (comprobado en un directo real), y si se
 * reabre al instante responde "overloaded". Cada apertura cuesta 5 unidades: reabriendo 4 s
 * después del cierre son ~4 aperturas por minuto, unas 1,200 unidades por hora (unas 8 horas de
 * directo al día con la cuota gratuita). No se pierde ningún mensaje: se sigue con nextPageToken.
 */
const RESUME_DELAY = 4_000;
/** Si el flujo es rechazado, se consulta por REST durante este tiempo antes de volver a probarlo. */
const POLL_PERIOD = 2 * 60_000;
/** Cada cuánto se consulta por REST (YouTube sugiere ~1 s, pero así se cuida la cuota: ~1,800 u/h). */
const POLL_INTERVAL = 10_000;
/** Fallos seguidos de InnerTube antes de pasar a la API oficial. */
const INNERTUBE_MAX_FAILURES = 3;
/** Tiempo con la API oficial antes de volver a probar InnerTube. */
const OFFICIAL_PERIOD = 10 * 60_000;
/** Los regalos de YouTube repiten el mismo id al sumar combo: se muestra el total tras esta pausa. */
const GIFT_COMBO_WAIT = 5_000;
/** Mensajes del historial inicial más viejos que esto (respecto a la conexión) no se muestran. */
const HISTORY_MARGIN = 5_000;

// ---------- Tipos de lo que devuelve el flujo (campos en camelCase, como los deja proto-loader) ----------

type LiveChatMessage = YouTubeChatItem;

interface LiveChatMessageListResponse {
  offlineAt?: string;
  nextPageToken?: string;
  items?: LiveChatMessage[];
}

interface StreamListClient extends grpc.Client {
  StreamList(request: object, metadata: grpc.Metadata): grpc.ClientReadableStream<LiveChatMessageListResponse>;
}

/** Cliente gRPC generado a partir del .proto (se carga una sola vez). */
let ServiceClient: (new (target: string, credentials: grpc.ChannelCredentials) => StreamListClient) | undefined;

function serviceClient(): new (target: string, credentials: grpc.ChannelCredentials) => StreamListClient {
  if (!ServiceClient) {
    const definition = protoLoader.loadSync(PROTO_FILE, { keepCase: false, longs: String, enums: String, defaults: false, oneofs: true });
    const loaded = grpc.loadPackageDefinition(definition) as unknown as {
      youtube: { api: { v3: { V3DataLiveChatMessageService: typeof ServiceClient } } };
    };
    ServiceClient = loaded.youtube.api.v3.V3DataLiveChatMessageService!;
  }
  return ServiceClient;
}

export class YouTubeConnector extends Connector {
  readonly platform = "youtube";

  readonly #auth: GoogleAuth;
  #client: StreamListClient | undefined;
  #call: grpc.ClientReadableStream<LiveChatMessageListResponse> | undefined;
  #closing = false;
  #attempts = 0;
  #timer: NodeJS.Timeout | undefined;

  #liveChatId: string | undefined;
  #pageToken: string | undefined;
  /** Cuándo se abrió el primer flujo de este chat (para descartar el historial viejo). */
  #firstConnectedAt = 0;
  /** Hasta cuándo se lee por REST porque el flujo fue rechazado. */
  #pollUntil = 0;
  #videoId: string | undefined;
  #innerTube = new InnerTubeChat();
  #innerTubeFailures = 0;
  /** Hasta cuándo se usa la API oficial porque InnerTube falló. */
  #officialUntil = 0;
  /** Fecha del mensaje más reciente mostrado, y desde cuál ignorar al cambiar de fuente (sin repetir). */
  #lastPublished = 0;
  #skipUntil = 0;
  readonly #giftCombos = new Map<string, { event: ChatEvent; timer: NodeJS.Timeout }>();

  constructor(auth: GoogleAuth) {
    super();
    this.#auth = auth;
  }

  async connect(): Promise<void> {
    this.#closing = false;
    this.#client = new (serviceClient())(GRPC_TARGET, grpc.credentials.createSsl());
    await this.#findBroadcast();
  }

  async disconnect(): Promise<void> {
    this.#closing = true;
    clearTimeout(this.#timer);
    this.#flushGifts();
    this.#call?.cancel();
    this.#call = undefined;
    this.#client?.close();
    this.#client = undefined;
    this.setStatus("disconnected");
  }

  #schedule(wait: number, action: () => Promise<void>): void {
    clearTimeout(this.#timer);
    this.#timer = setTimeout(() => {
      if (!this.#closing) void action();
    }, wait);
  }

  #backoff({ min, max }: { min: number; max: number }): number {
    return Math.min(max, min * 2 ** this.#attempts++);
  }

  // ---------- Buscar el directo ----------

  async #findBroadcast(retryAuth = true): Promise<void> {
    if (this.#closing) return;
    if (this.status !== "disconnected" || this.#attempts === 0) this.setStatus("connecting");

    try {
      // broadcastStatus ya filtra por el canal de la cuenta conectada; no se puede combinar con mine.
      const params = new URLSearchParams({ part: "snippet", broadcastStatus: "active", broadcastType: "all" });
      const response = await fetch(`${BROADCASTS_URL}?${params}`, {
        headers: { Authorization: `Bearer ${await this.#auth.getAccessToken()}` },
      });
      if (this.#closing) return;

      if (response.status === 401 && retryAuth) {
        await this.#auth.refresh();
        return this.#findBroadcast(false);
      }
      if (!response.ok) {
        const reason = await apiErrorReason(response);
        if (reason === "quotaExceeded") {
          this.setStatus("error", "Se acabó la cuota diaria de YouTube; se reintenta en 30 min");
          return this.#schedule(QUOTA_RETRY, () => this.#findBroadcast());
        }
        throw new Error(`No se pudo buscar el directo (${reason})`);
      }

      const data = (await response.json()) as { items?: { id?: string; snippet?: { liveChatId?: string } }[] };
      const broadcast = data.items?.find((item) => item.snippet?.liveChatId);
      const liveChatId = broadcast?.snippet?.liveChatId;
      if (!liveChatId) {
        this.setStatus("disconnected", "No hay ningún directo activo en tu canal");
        return this.#schedule(this.#backoff(OFFLINE_RETRY), () => this.#findBroadcast());
      }

      this.#attempts = 0;
      this.#liveChatId = liveChatId;
      this.#videoId = broadcast?.id;
      this.#pageToken = undefined;
      this.#firstConnectedAt = Date.now();
      this.#innerTubeFailures = 0;
      this.#officialUntil = 0;
      await this.#startInnerTube();
    } catch (error) {
      if (this.#closing) return;
      this.setStatus("reconnecting", error instanceof Error ? error.message : String(error));
      this.#schedule(this.#backoff(ERROR_RETRY), () => this.#findBroadcast());
    }
  }

  // ---------- Flujo del chat ----------

  async #openStream(): Promise<void> {
    if (this.#closing || !this.#client || !this.#liveChatId) return;

    const metadata = new grpc.Metadata();
    metadata.set("authorization", `Bearer ${await this.#auth.getAccessToken()}`);
    const request = {
      liveChatId: this.#liveChatId,
      part: ["id", "snippet", "authorDetails"],
      profileImageSize: 64,
      ...(this.#pageToken ? { pageToken: this.#pageToken } : {}),
    };

    const call = this.#client.StreamList(request, metadata);
    this.#call = call;
    let receivedData = false;
    const current = () => call === this.#call && !this.#closing;

    call.on("data", (response: LiveChatMessageListResponse) => {
      if (!current()) return;
      receivedData = true;
      this.#attempts = 0;
      if (this.status !== "connected") this.setStatus("connected");
      if (response.nextPageToken) this.#pageToken = response.nextPageToken;
      for (const item of response.items ?? []) this.#onMessage(item);
      if (response.offlineAt) this.#chatEnded("El directo terminó");
    });

    call.on("error", (error: grpc.ServiceError) => {
      if (!current()) return;
      this.#call = undefined;
      void this.#onStreamError(error);
    });

    call.on("end", () => {
      if (!current()) return;
      this.#call = undefined;
      // Cierre normal (YouTube lo hace cada ~10 s): se reabre donde iba tras una pausa corta.
      // Si se cerró sin traer nada, algo va mal: se espera cada vez más.
      this.#scheduleOfficial(receivedData ? RESUME_DELAY : this.#backoff(ERROR_RETRY), () => this.#openStream());
    });
  }

  async #onStreamError(error: grpc.ServiceError): Promise<void> {
    const message = error.details || error.message;
    switch (error.code) {
      case grpc.status.UNAUTHENTICATED:
        try {
          await this.#auth.refresh();
          this.#schedule(500, () => this.#openStream());
        } catch {
          this.setStatus("error", "La sesión de YouTube ya no es válida");
        }
        return;
      case grpc.status.FAILED_PRECONDITION:
      case grpc.status.NOT_FOUND:
        // liveChatEnded, liveChatDisabled o liveChatNotFound.
        this.#chatEnded(/disabled/i.test(message) ? "El chat del directo está desactivado" : "El directo terminó");
        return;
      case grpc.status.RESOURCE_EXHAUSTED:
        if (/quota/i.test(message)) {
          this.setStatus("error", "Se acabó la cuota diaria de YouTube; se reintenta en 30 min");
          this.#schedule(QUOTA_RETRY, () => this.#openStream());
        } else {
          this.setStatus("reconnecting", "YouTube pidió ir más despacio");
          this.#schedule(30_000, () => this.#openStream());
        }
        return;
      case grpc.status.INVALID_ARGUMENT:
        // Token de página inválido: se empieza de nuevo sin él.
        this.#pageToken = undefined;
        this.#schedule(1_000, () => this.#openStream());
        return;
      case grpc.status.UNAVAILABLE:
        // "overloaded": el flujo no está disponible por ahora. Se sigue por REST un rato.
        this.#pollUntil = Date.now() + POLL_PERIOD;
        await this.#poll();
        return;
      default:
        this.setStatus("reconnecting", message);
        this.#schedule(this.#backoff(ERROR_RETRY), () => this.#openStream());
    }
  }

  // ---------- InnerTube (principal) ----------

  async #startInnerTube(): Promise<void> {
    if (this.#closing || !this.#videoId) return;
    try {
      await this.#innerTube.start(this.#videoId);
      await this.#pollInnerTube();
    } catch (error) {
      this.#innerTubeFailed(error);
    }
  }

  async #pollInnerTube(): Promise<void> {
    if (this.#closing) return;
    try {
      const page = await this.#innerTube.next();
      if (this.#closing) return;
      this.#innerTubeFailures = 0;
      this.#attempts = 0;
      // Al volver de la API oficial se borra el aviso de respaldo ("" lo oculta en la interfaz).
      if (this.status !== "connected" || this.#officialUntil !== 0) {
        this.#officialUntil = 0;
        this.setStatus("connected", "");
      }
      for (const item of page.items) this.#onMessage(item);
      this.#schedule(page.waitMs, () => this.#pollInnerTube());
    } catch (error) {
      this.#innerTubeFailed(error);
    }
  }

  #innerTubeFailed(error: unknown): void {
    if (this.#closing) return;
    const reason = error instanceof Error ? error.message : String(error);
    if (++this.#innerTubeFailures < INNERTUBE_MAX_FAILURES) {
      // Puede ser un fallo pasajero: se reabre el chat y se vuelve a probar en unos segundos.
      this.#schedule(3_000, () => this.#startInnerTube());
      return;
    }
    // InnerTube no responde (o el directo terminó): la API oficial lo confirma o sigue leyendo.
    console.error("YouTube: InnerTube falló, se usa la API oficial:", reason);
    this.#innerTubeFailures = 0;
    this.#officialUntil = Date.now() + OFFICIAL_PERIOD;
    this.#skipUntil = this.#lastPublished;
    this.#pageToken = undefined;
    this.setStatus("connected", "Usando la API oficial de respaldo (InnerTube no responde)");
    void this.#openStream();
  }

  #usingOfficial(): boolean {
    return Date.now() < this.#officialUntil;
  }

  /** Programa el siguiente paso de la API oficial, o vuelve a InnerTube si ya pasó el periodo. */
  #scheduleOfficial(wait: number, action: () => Promise<void>): void {
    if (this.#usingOfficial()) {
      this.#schedule(wait, action);
      return;
    }
    this.#call?.cancel();
    this.#call = undefined;
    this.#skipUntil = this.#lastPublished;
    this.#schedule(wait, () => this.#startInnerTube());
  }

  // ---------- Respaldo por REST ----------

  /** Consulta el chat por liveChatMessages.list y programa la siguiente (o vuelve al flujo). */
  async #poll(retryAuth = true): Promise<void> {
    if (this.#closing || !this.#liveChatId) return;
    try {
      const params = new URLSearchParams({
        liveChatId: this.#liveChatId,
        part: "id,snippet,authorDetails",
        profileImageSize: "64",
        ...(this.#pageToken ? { pageToken: this.#pageToken } : {}),
      });
      const response = await fetch(`${MESSAGES_URL}?${params}`, {
        headers: { Authorization: `Bearer ${await this.#auth.getAccessToken()}` },
      });
      if (this.#closing) return;

      if (response.status === 401 && retryAuth) {
        await this.#auth.refresh();
        return this.#poll(false);
      }
      if (!response.ok) {
        const reason = await apiErrorReason(response);
        if (reason === "quotaExceeded") {
          this.setStatus("error", "Se acabó la cuota diaria de YouTube; se reintenta en 30 min");
          return this.#schedule(QUOTA_RETRY, () => this.#poll());
        }
        if (reason === "liveChatEnded" || reason === "liveChatNotFound") return this.#chatEnded("El directo terminó");
        if (reason === "liveChatDisabled") return this.#chatEnded("El chat del directo está desactivado");
        throw new Error(`No se pudo leer el chat (${reason})`);
      }

      const data = (await response.json()) as LiveChatMessageListResponse;
      this.#attempts = 0;
      if (this.status !== "connected") this.setStatus("connected");
      if (data.nextPageToken) this.#pageToken = data.nextPageToken;
      // REST da los tipos en camelCase ("textMessageEvent"); el flujo, como en el .proto.
      for (const item of data.items ?? []) {
        if (item.snippet?.type) item.snippet.type = item.snippet.type.replace(/([A-Z])/g, "_$1").toUpperCase();
        this.#onMessage(item);
      }
      if (data.offlineAt) return this.#chatEnded("El directo terminó");

      if (Date.now() < this.#pollUntil) this.#scheduleOfficial(POLL_INTERVAL, () => this.#poll());
      else this.#scheduleOfficial(RESUME_DELAY, () => this.#openStream());
    } catch (error) {
      if (this.#closing) return;
      this.setStatus("reconnecting", error instanceof Error ? error.message : String(error));
      this.#schedule(this.#backoff(ERROR_RETRY), () => this.#poll());
    }
  }

  #chatEnded(reason: string): void {
    this.#call?.cancel();
    this.#call = undefined;
    this.#flushGifts();
    this.#liveChatId = undefined;
    this.#videoId = undefined;
    this.#pageToken = undefined;
    this.#attempts = 0;
    this.#officialUntil = 0;
    this.#innerTubeFailures = 0;
    this.setStatus("disconnected", reason);
    this.#schedule(OFFLINE_RETRY.min, () => this.#findBroadcast());
  }

  // ---------- Traducción ----------

  #onMessage(item: LiveChatMessage): void {
    const snippet = item.snippet ?? {};
    // El primer flujo trae el historial reciente: lo anterior a la conexión no se muestra.
    const published = Date.parse(snippet.publishedAt ?? "");
    if (Number.isFinite(published)) {
      if (published < this.#firstConnectedAt - HISTORY_MARGIN) return;
      // Al cambiar entre InnerTube y la API oficial, lo ya mostrado puede volver a llegar.
      if (published <= this.#skipUntil) return;
      this.#lastPublished = Math.max(this.#lastPublished, published);
    }

    const base = (type: EventType): ChatEvent => ({
      id: `youtube-${item.id ?? `${Date.now()}-${Math.random()}`}`,
      platform: "youtube",
      type,
      user: {
        id: item.authorDetails?.channelId ?? "",
        name: item.authorDetails?.displayName ?? "anónimo",
        ...(item.authorDetails?.profileImageUrl ? { avatar: item.authorDetails.profileImageUrl } : {}),
      },
      flags: { firstTime: false, question: false },
      timestamp: Number.isFinite(published) ? new Date(published).toISOString() : new Date().toISOString(),
    });
    const level = (name: string | undefined) => (name ? `Nivel: ${name}` : undefined);
    const micros = (value: string | undefined) => (value ? Number(value) / 1_000_000 : undefined);

    switch (snippet.type) {
      case "TEXT_MESSAGE_EVENT": {
        const event = base("chat");
        event.text = snippet.textMessageDetails?.messageText ?? snippet.displayMessage ?? "";
        if (item.fragments) event.fragments = item.fragments;
        this.emit("event", event);
        return;
      }
      case "SUPER_CHAT_EVENT": {
        const details = snippet.superChatDetails ?? {};
        const event = base("superchat");
        assign(event, { detail: details.amountDisplayString, amount: micros(details.amountMicros), text: details.userComment });
        this.emit("event", event);
        return;
      }
      case "SUPER_STICKER_EVENT": {
        const details = snippet.superStickerDetails ?? {};
        const event = base("superchat");
        const sticker = details.superStickerMetadata?.altText;
        assign(event, { detail: details.amountDisplayString, amount: micros(details.amountMicros), text: sticker ? `Super Sticker: ${sticker}` : "Super Sticker" });
        this.emit("event", event);
        return;
      }
      case "NEW_SPONSOR_EVENT": {
        const event = base("member");
        assign(event, { detail: level(snippet.newSponsorDetails?.memberLevelName) });
        this.emit("event", event);
        return;
      }
      case "MEMBER_MILESTONE_CHAT_EVENT": {
        const details = snippet.memberMilestoneChatDetails ?? {};
        const event = base("member");
        assign(event, { detail: level(details.memberLevelName), amount: details.memberMonth, text: details.userComment });
        this.emit("event", event);
        return;
      }
      case "MEMBERSHIP_GIFTING_EVENT": {
        const details = snippet.membershipGiftingDetails ?? {};
        const event = base("giftsub");
        assign(event, { detail: level(details.giftMembershipsLevelName), amount: details.giftMembershipsCount ?? 1 });
        this.emit("event", event);
        return;
      }
      case "GIFT_EVENT":
        this.#onGift(item.id ?? "", base("gift"), snippet.giftDetails ?? {});
        return;
      case "CHAT_ENDED_EVENT":
        this.#chatEnded("El directo terminó");
        return;
      // Los demás (borrados, baneos, encuestas, modo solo miembros, membresía regalada recibida) no se muestran.
    }
  }

  /** YouTube reenvía el mismo regalo con el mismo id mientras sube el combo: se muestra el total al final. */
  #onGift(id: string, event: ChatEvent, details: { giftName?: string; comboCount?: number }): void {
    assign(event, { detail: details.giftName || "un regalo", amount: Math.max(1, details.comboCount ?? 1) });
    const pending = this.#giftCombos.get(id);
    if (pending) clearTimeout(pending.timer);
    this.#giftCombos.set(id, {
      event,
      timer: setTimeout(() => {
        this.#giftCombos.delete(id);
        this.emit("event", event);
      }, GIFT_COMBO_WAIT),
    });
  }

  #flushGifts(): void {
    for (const { event, timer } of this.#giftCombos.values()) {
      clearTimeout(timer);
      this.emit("event", event);
    }
    this.#giftCombos.clear();
  }
}

/** Copia solo los campos con valor (para no dejar `detail: undefined` en el evento). */
function assign(event: ChatEvent, fields: Partial<Pick<ChatEvent, "detail" | "amount" | "text">>): void {
  for (const [key, value] of Object.entries(fields)) {
    if (value !== undefined && value !== "" && !(typeof value === "number" && !Number.isFinite(value))) {
      (event as unknown as Record<string, unknown>)[key] = value;
    }
  }
}

/** Motivo del error de la API REST de YouTube (por ejemplo, "quotaExceeded"). */
async function apiErrorReason(response: Response): Promise<string> {
  const data = (await response.json().catch(() => ({}))) as { error?: { errors?: { reason?: string }[]; message?: string } };
  return data.error?.errors?.[0]?.reason ?? data.error?.message ?? `HTTP ${response.status}`;
}
