// Pruebas de las reglas NUEVO y PREGUNTA. Se corren con: npm test

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ChatEvent } from "./event.ts";
import { applyRules, hasQuestionMark, mentions, type RuleContext } from "./rules.ts";

const context: RuleContext = { mentionNames: ["arcoszr", "Lalo", "el profe"], ownNames: ["arcoszr", "ArcosZR"] };

function chat(text: string, name = "viewer", firstTime = false): ChatEvent {
  return {
    id: "1",
    platform: "twitch",
    type: "chat",
    user: { id: "1", name },
    text,
    flags: { firstTime, question: false },
    timestamp: "2026-10-27T00:00:00.000Z",
  };
}

describe("hasQuestionMark", () => {
  it("detecta ? y ¿", () => {
    assert.equal(hasQuestionMark("¿Qué juego toca hoy?"), true);
    assert.equal(hasQuestionMark("qué juego toca hoy?"), true);
    assert.equal(hasQuestionMark("¿y eso"), true);
  });

  it("ignora los ? de los enlaces", () => {
    assert.equal(hasQuestionMark("mira https://youtube.com/watch?v=abc"), false);
    assert.equal(hasQuestionMark("www.sitio.com/?a=1 jaja"), false);
    assert.equal(hasQuestionMark("mira https://sitio.com/?a=1 ¿lo viste?"), true);
  });

  it("no marca mensajes sin signos", () => {
    assert.equal(hasQuestionMark("GG"), false);
  });
});

describe("mentions", () => {
  it("encuentra el nombre con o sin @, sin importar mayúsculas ni acentos", () => {
    assert.equal(mentions("hola @arcoszr", context.mentionNames), true);
    assert.equal(mentions("hola ARCOSZR", context.mentionNames), true);
    assert.equal(mentions("buenas Laló", context.mentionNames), true);
    assert.equal(mentions("saludos al profe, digo, el profe", context.mentionNames), true);
  });

  it("no cuenta el nombre dentro de otra palabra", () => {
    assert.equal(mentions("los lalos", context.mentionNames), false);
    assert.equal(mentions("arcoszr_fan dice hola", context.mentionNames), false);
  });

  it("ignora nombres vacíos", () => {
    assert.equal(mentions("hola", ["", "  ", "@"]), false);
  });
});

describe("applyRules", () => {
  it("marca PREGUNTA por signo o por mención", () => {
    assert.equal(applyRules(chat("¿qué sensibilidad usas?"), context).flags.question, true);
    assert.equal(applyRules(chat("@ArcosZR saludos"), context).flags.question, true);
    assert.equal(applyRules(chat("GG"), context).flags.question, false);
  });

  it("no marca los mensajes del propio streamer", () => {
    assert.equal(applyRules(chat("¿me escuchan?", "ArcosZR"), context).flags.question, false);
  });

  it("respeta NUEVO tal como viene de la plataforma", () => {
    assert.equal(applyRules(chat("hola", "viewer", true), context).flags.firstTime, true);
    assert.equal(applyRules(chat("hola", "viewer", false), context).flags.firstTime, false);
  });

  it("deja las alertas sin tocar", () => {
    const alert: ChatEvent = { ...chat("¿?"), type: "bits" };
    assert.equal(applyRules(alert, context), alert);
  });
});
