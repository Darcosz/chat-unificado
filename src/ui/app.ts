// Interfaz: recibe los eventos del servidor local por WebSocket y los pinta en el chat
// (más antiguo arriba) o en el panel de alertas (más reciente arriba).

import { PLATFORMS, isChat, type ChatEvent, type ChatHighlight, type EventType, type Platform } from "../core/event.ts";
import { STATUS_TEXT, type ConnectionStatus, type ServerMessage } from "../core/protocol.ts";
import { onChange, renderSettings, renderTwitch, setCardStatus, setVersion } from "./settings.ts";

type Filter = Platform | "all";
type Category = "followers" | "subscription" | "money" | "points" | "raid";

const NAMES: Record<Platform, string> = { twitch: "Twitch", tiktok: "TikTok", youtube: "YouTube", kick: "Kick" };

/** Iconos de las etiquetas de alerta. Son constantes, así que es seguro usar innerHTML. */
const ICONS: Record<Category, string> = {
  followers: '<svg viewBox="0 0 24 24"><path d="M12 20s-7.5-4.6-7.5-10.2A4.3 4.3 0 0 1 12 7.2a4.3 4.3 0 0 1 7.5 2.6C19.5 15.4 12 20 12 20z"/></svg>',
  subscription: '<svg viewBox="0 0 24 24"><path d="m12 3 2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1-4.4-4.3 6.1-.9z"/></svg>',
  money: '<svg viewBox="0 0 24 24"><path d="m12 3 8 9-8 9-8-9z"/></svg>',
  points: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="3"/></svg>',
  raid: '<svg viewBox="0 0 24 24"><path d="M5 19 19 5M9 5h10v10"/></svg>',
};

const ALERTS: Record<Exclude<EventType, "chat">, { label: string; category: Category }> = {
  follow: { label: "Follow", category: "followers" },
  sub: { label: "Sub", category: "subscription" },
  giftsub: { label: "Sub regalada", category: "subscription" },
  member: { label: "Miembro", category: "subscription" },
  bits: { label: "Bits", category: "money" },
  superchat: { label: "Super Chat", category: "money" },
  kicks: { label: "Kicks", category: "money" },
  gift: { label: "Regalo", category: "money" },
  reward: { label: "Puntos", category: "points" },
  raid: { label: "Raid", category: "raid" },
};

/** Etiqueta y color de los mensajes de chat resaltados. */
const HIGHLIGHTS: Record<ChatHighlight, { category: Category; label: (event: ChatEvent) => string }> = {
  bits: { category: "money", label: (event) => `${formatNumber(event.amount)} bits` },
  highlighted: { category: "points", label: () => "Destacado" },
};

/** Límite de elementos en pantalla para que la ventana no se vuelva lenta en streams largos. */
const MAX_MESSAGES = 500;
const MAX_ALERTS = 200;

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const app = $("app");
const chatList = $("chat");
const alertList = $("alerts");
const footer = $("footer");
const footerText = $("footer-text");
const pauseButton = $<HTMLButtonElement>("pause");
const counter = $("counter");
const notice = $("notice");

const statusPills = new Map<Platform, HTMLElement>();
const filterButtons = new Map<Filter, HTMLButtonElement>();

let filter: Filter = "all";
let autoScroll = true;
/** true si se pausó con el botón: entonces volver al final no lo reanuda solo. */
let manualPause = false;
let pending = 0;

// ---------- Utilidades ----------

function create<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

/** Logo de la plataforma. Es decorativo: el nombre siempre va escrito al lado. */
function logo(platform: Platform): HTMLImageElement {
  const image = create("img", "logo");
  image.src = `/logos/${platform}.png`;
  image.alt = "";
  image.setAttribute("aria-hidden", "true");
  return image;
}

function formatTime(date: Date): string {
  return date.toLocaleTimeString("es-MX", { hour: "2-digit", minute: "2-digit", hour12: false });
}

function dayKey(date: Date): string {
  return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
}

function formatNumber(value: number | undefined): string {
  return (value ?? 0).toLocaleString("es-MX");
}

function isVisible(event: ChatEvent): boolean {
  return filter === "all" || filter === event.platform;
}

// ---------- Cabecera: estados y filtros ----------

function buildHeader(): void {
  const statuses = $("statuses");
  for (const platform of PLATFORMS) {
    const pill = create("span", "status-pill");
    pill.dataset.platform = platform;
    pill.append(logo(platform), NAMES[platform]);
    statuses.append(pill);
    statusPills.set(platform, pill);
    setStatus(platform, "disconnected");
  }

  const filters = $("filters");
  for (const option of ["all", ...PLATFORMS] as const) {
    const button = create("button", "filter");
    button.type = "button";
    if (option === "all") button.append("Todos");
    else button.append(logo(option), NAMES[option]);
    button.addEventListener("click", () => selectFilter(option));
    filters.append(button);
    filterButtons.set(option, button);
  }

  let saved: string | null = null;
  try {
    saved = localStorage.getItem("filter");
  } catch {
    // Sin almacenamiento disponible: se queda en "all".
  }
  selectFilter(saved && filterButtons.has(saved as Filter) ? (saved as Filter) : "all");
}

function setStatus(platform: Platform, status: ConnectionStatus, detail?: string): void {
  setCardStatus(platform, status, detail);
  const pill = statusPills.get(platform);
  if (!pill) return;
  pill.dataset.status = status;
  pill.title = `${NAMES[platform]}: ${STATUS_TEXT[status]}${detail ? ` (${detail})` : ""}`;
}

function selectFilter(next: Filter): void {
  filter = next;
  app.dataset.filter = next;
  for (const [option, button] of filterButtons) button.setAttribute("aria-pressed", String(option === next));
  try {
    localStorage.setItem("filter", next);
  } catch {
    // No pasa nada si no se puede guardar.
  }
  pending = 0;
  if (autoScroll) scrollToEnd();
  updateFooter();
  updateCounter();
  updateEmpty();
}

// ---------- Chat ----------

/** Etiqueta de tipo con icono y color de categoría (alertas y mensajes resaltados). */
function typeTag(category: Category, label: string): HTMLElement {
  const tag = create("span", "tag tag-type");
  tag.dataset.category = category;
  tag.innerHTML = ICONS[category];
  tag.append(label);
  return tag;
}

/** Texto del mensaje con los emotes como imagen. Todo el texto va con textContent, nunca como HTML. */
function messageText(event: ChatEvent): HTMLElement {
  const container = create("div", "text");
  if (!event.fragments) {
    container.textContent = event.text ?? "";
    return container;
  }
  for (const fragment of event.fragments) {
    if (fragment.type === "text" || !fragment.url.startsWith("https://")) {
      container.append(fragment.type === "text" ? fragment.text : fragment.name);
    } else {
      const emote = create("img", "emote");
      emote.src = fragment.url;
      emote.alt = fragment.name;
      // Sin loading="lazy": con la ventana oculta o minimizada el navegador las dejaría sin cargar.
      emote.title = fragment.name;
      container.append(emote);
    }
  }
  return container;
}

function createMessage(event: ChatEvent): HTMLElement {
  const card = create("article", "message");
  card.dataset.platform = event.platform;

  const header = create("div", "message-header");
  header.append(logo(event.platform), create("span", "tag tag-platform", event.platform), create("span", "name", event.user.name));
  if (event.highlight) {
    const { category, label } = HIGHLIGHTS[event.highlight];
    card.dataset.highlight = event.highlight;
    card.dataset.category = category;
    header.append(typeTag(category, label(event)));
  }
  if (event.flags.firstTime) header.append(create("span", "tag tag-new", "Nuevo"));
  if (event.flags.question) header.append(create("span", "tag tag-question", "Pregunta"));
  header.append(create("time", "time", formatTime(new Date(event.timestamp))));

  card.append(header, messageText(event));
  return card;
}

function addMessage(event: ChatEvent): void {
  chatList.append(createMessage(event));

  if (autoScroll) {
    // Solo se recortan los viejos con auto-scroll activo; si no, la vista saltaría.
    while (chatList.childElementCount > MAX_MESSAGES) chatList.firstElementChild?.remove();
    scrollToEnd();
  } else if (isVisible(event)) {
    pending++;
    updateFooter();
  }
}

function isNearEnd(): boolean {
  return chatList.scrollHeight - chatList.scrollTop - chatList.clientHeight < 40;
}

function scrollToEnd(): void {
  chatList.scrollTop = chatList.scrollHeight;
}

function pause(manual: boolean): void {
  autoScroll = false;
  manualPause = manual;
  updateFooter();
}

function resume(): void {
  autoScroll = true;
  manualPause = false;
  pending = 0;
  scrollToEnd();
  updateFooter();
}

function updateFooter(): void {
  footer.dataset.paused = String(!autoScroll);
  pauseButton.textContent = autoScroll ? "Pausar" : "Reanudar";
  if (autoScroll) {
    footerText.textContent = "Auto-scroll activo";
  } else if (pending > 0) {
    footerText.textContent = `Auto-scroll en pausa · ${pending} ${pending === 1 ? "mensaje nuevo" : "mensajes nuevos"}`;
  } else {
    footerText.textContent = "Auto-scroll en pausa";
  }
}

// Subir el chat pausa el auto-scroll; volver al final lo reanuda. Solo cuenta si el scroll
// subió, para que cambiar el tamaño de la ventana no lo pause por error.
let lastScrollTop = 0;
chatList.addEventListener("scroll", () => {
  const scrolledUp = chatList.scrollTop < lastScrollTop;
  lastScrollTop = chatList.scrollTop;
  if (isNearEnd()) {
    if (!autoScroll && !manualPause) resume();
  } else if (autoScroll && scrolledUp) {
    pause(false);
  }
});

new ResizeObserver(() => {
  if (autoScroll) scrollToEnd();
}).observe(chatList);

pauseButton.addEventListener("click", () => (autoScroll ? pause(true) : resume()));

// ---------- Alertas ----------

function alertTitle(event: ChatEvent): string {
  const name = event.user.name;
  switch (event.type) {
    case "follow":
      return `${name} te siguió`;
    case "sub":
      return event.amount && event.amount > 1 ? `${name} se suscribió · ${formatNumber(event.amount)} meses` : `${name} se suscribió`;
    case "giftsub":
      return event.amount && event.amount > 1 ? `${name} regaló ${formatNumber(event.amount)} subs` : `${name} regaló una sub`;
    case "member":
      return event.amount && event.amount > 1 ? `${name} es miembro · ${formatNumber(event.amount)} meses` : `${name} se hizo miembro`;
    case "bits":
      return `${name} envió ${formatNumber(event.amount)} bits`;
    case "superchat":
      return `${name} envió un Super Chat${event.detail ? ` de ${event.detail}` : ""}`;
    case "kicks":
      return `${name} envió ${formatNumber(event.amount)} Kicks`;
    case "gift":
      return `${name} envió ${event.detail ?? "un regalo"} × ${formatNumber(event.amount ?? 1)}`;
    case "reward":
      return `${name} canjeó «${event.detail ?? "una recompensa"}»`;
    case "raid":
      return `${name} te hizo raid con ${formatNumber(event.amount)} ${event.amount === 1 ? "espectador" : "espectadores"}`;
    case "chat":
      return name;
  }
}

function alertDetail(event: ChatEvent): string | undefined {
  switch (event.type) {
    case "sub":
    case "giftsub":
    case "member":
      return event.detail;
    case "reward":
      return event.amount !== undefined ? `${formatNumber(event.amount)} puntos del canal` : undefined;
    default:
      return undefined;
  }
}

function createAlert(event: ChatEvent): HTMLElement | undefined {
  if (event.type === "chat") return undefined;
  const { label, category } = ALERTS[event.type];
  const date = new Date(event.timestamp);

  const card = create("article", "alert");
  card.dataset.platform = event.platform;
  card.dataset.category = category;
  card.dataset.day = dayKey(date);

  const header = create("div", "alert-header");
  header.append(logo(event.platform), create("span", "tag tag-platform", event.platform), typeTag(category, label), create("time", "time", formatTime(date)));
  card.append(header, create("div", "alert-title", alertTitle(event)));

  const detail = alertDetail(event);
  if (detail) card.append(create("div", "alert-detail", detail));
  if (event.text) card.append(create("div", "alert-message", event.text));
  return card;
}

function addAlert(event: ChatEvent): void {
  const card = createAlert(event);
  if (!card) return;
  alertList.prepend(card);
  while (alertList.childElementCount > MAX_ALERTS) alertList.lastElementChild?.remove();
  updateCounter();
}

/** Cuenta las alertas de hoy que deja ver el filtro. */
function updateCounter(): void {
  const today = dayKey(new Date());
  let total = 0;
  for (const alert of alertList.children as HTMLCollectionOf<HTMLElement>) {
    if (alert.dataset.day === today && (filter === "all" || alert.dataset.platform === filter)) total++;
  }
  counter.textContent = `${total} hoy`;
}

/** Marca las listas sin nada visible para que muestren su texto de "vacío". */
function updateEmpty(): void {
  const selector = filter === "all" ? "[data-platform]" : `[data-platform="${filter}"]`;
  for (const list of [chatList, alertList]) list.toggleAttribute("data-empty", !list.querySelector(selector));
}

// Por si la ventana sigue abierta al cambiar de día.
setInterval(updateCounter, 60_000);

// ---------- Conexión con el servidor ----------

function add(event: ChatEvent): void {
  if (isChat(event)) addMessage(event);
  else addAlert(event);
  if (isVisible(event)) updateEmpty();
}

function receive(message: ServerMessage): void {
  switch (message.type) {
    case "init":
      setVersion(message.version);
      renderSettings(message.config);
      renderTwitch(message.twitch);
      chatList.replaceChildren();
      alertList.replaceChildren();
      for (const platform of PLATFORMS) {
        const { status, detail } = message.statuses[platform];
        setStatus(platform, status, detail);
      }
      for (const event of message.history) add(event);
      updateCounter();
      updateEmpty();
      if (autoScroll) scrollToEnd();
      break;
    case "event":
      add(message.event);
      break;
    case "status":
      setStatus(message.platform, message.status, message.detail);
      break;
    case "config":
      renderSettings(message.config);
      break;
    case "twitch":
      renderTwitch(message.twitch);
      break;
  }
}

// ---------- Preferencias y navegación ----------

// Las preferencias que afectan al chat se aplican como atributos que lee el CSS.
onChange((config) => {
  app.dataset.textSize = config.window.textSize;
  app.dataset.alertsSide = config.window.alertsSide;
  app.toggleAttribute("data-hide-new", !config.tags.markNew);
  app.toggleAttribute("data-hide-question", !config.tags.markQuestion);
  if (autoScroll) scrollToEnd();
});

/** La configuración vive en #settings, así sobrevive a recargar la página. */
function showView(): void {
  const inSettings = location.hash === "#settings";
  $("chat-view").hidden = inSettings;
  $("settings-view").hidden = !inSettings;
}

window.addEventListener("hashchange", showView);
showView();

let attempts = 0;

function connect(): void {
  const protocol = location.protocol === "https:" ? "wss" : "ws";
  const socket = new WebSocket(`${protocol}://${location.host}/ws`);

  socket.addEventListener("open", () => {
    attempts = 0;
    notice.hidden = true;
  });
  socket.addEventListener("message", (message) => receive(JSON.parse(String(message.data)) as ServerMessage));
  socket.addEventListener("close", () => {
    notice.hidden = false;
    for (const platform of PLATFORMS) setStatus(platform, "disconnected");
    setTimeout(connect, Math.min(10_000, 1000 * 2 ** attempts++));
  });
}

buildHeader();
updateFooter();
connect();
