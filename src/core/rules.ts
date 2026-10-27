// Reglas que se aplican a cada mensaje de chat antes de mandarlo a la interfaz
// (sección 3.3 de la especificación):
// - NUEVO: primera vez que el usuario escribe. Se respeta lo que indique la plataforma
//   (Twitch lo manda en cada mensaje); las que no lo indican lo calcularán con los usuarios
//   ya vistos guardados localmente (fase 2).
// - PREGUNTA: el mensaje lleva "?" o "¿", o menciona al streamer.
// La interfaz decide si muestra o no cada etiqueta según la configuración.

import type { ChatEvent } from "./event.ts";

export interface RuleContext {
  /** Nombres que cuentan como mención: el canal, la cuenta y los apodos de la configuración. */
  mentionNames: string[];
  /** Nombres de las cuentas del propio streamer: sus mensajes no se marcan como pregunta. */
  ownNames: string[];
}

/** Minúsculas y sin acentos, para comparar "Lalo", "LALO" y "Laló" igual. */
function normalize(text: string): string {
  return text.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Los "?" de los enlaces (https://sitio.com/?v=1) no son preguntas. */
function withoutLinks(text: string): string {
  return text.replace(/\b(?:https?:\/\/|www\.)\S+/gi, " ");
}

export function hasQuestionMark(text: string): boolean {
  return /[?¿]/.test(withoutLinks(text));
}

/** true si el texto nombra a alguno de `names` como palabra completa, con o sin @. */
export function mentions(text: string, names: string[]): boolean {
  const normalized = normalize(withoutLinks(text));
  return names.some((name) => {
    const clean = normalize(name.trim().replace(/^@/, ""));
    if (!clean) return false;
    // Delante y detrás no puede haber letra, número ni guion bajo: "lalo" no cuenta dentro de "lalos".
    return new RegExp(`(?<![\\p{L}\\p{N}_])@?${escapeRegExp(clean)}(?![\\p{L}\\p{N}_])`, "u").test(normalized);
  });
}

export function applyRules(event: ChatEvent, context: RuleContext): ChatEvent {
  if (event.type !== "chat") return event;

  const text = event.text ?? "";
  const ownNames = new Set(context.ownNames.map(normalize));
  const isOwn = ownNames.has(normalize(event.user.name));
  const question = !isOwn && (hasQuestionMark(text) || mentions(text, context.mentionNames));

  return { ...event, flags: { ...event.flags, question } };
}
