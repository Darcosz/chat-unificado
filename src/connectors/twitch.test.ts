// Pruebas del parseo de emotes de Twitch. Se corren con: npm test

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildFragments } from "./twitch.ts";

const url = (id: string) => `https://static-cdn.jtvnw.net/emoticons/v2/${id}/default/dark/2.0`;

describe("buildFragments", () => {
  it("devuelve undefined si no hay emotes", () => {
    assert.equal(buildFragments("hola", undefined), undefined);
    assert.equal(buildFragments("hola", null), undefined);
    assert.equal(buildFragments("hola", {}), undefined);
  });

  it("parte texto y emotes", () => {
    assert.deepEqual(buildFragments("Kappa hola", { "25": ["0-4"] }), [
      { type: "emote", name: "Kappa", url: url("25") },
      { type: "text", text: " hola" },
    ]);
  });

  it("ordena varios emotes y repeticiones", () => {
    assert.deepEqual(buildFragments("a LUL b Kappa c LUL", { "25": ["8-12"], "425618": ["2-4", "16-18"] }), [
      { type: "text", text: "a " },
      { type: "emote", name: "LUL", url: url("425618") },
      { type: "text", text: " b " },
      { type: "emote", name: "Kappa", url: url("25") },
      { type: "text", text: " c " },
      { type: "emote", name: "LUL", url: url("425618") },
    ]);
  });

  it("cuenta posiciones en caracteres Unicode, no en UTF-16", () => {
    // El emoji ocupa 2 unidades UTF-16 pero Twitch lo cuenta como 1 carácter.
    assert.deepEqual(buildFragments("😀 Kappa", { "25": ["2-6"] }), [
      { type: "text", text: "😀 " },
      { type: "emote", name: "Kappa", url: url("25") },
    ]);
  });

  it("ignora rangos inválidos e ids raros", () => {
    assert.equal(buildFragments("hola", { "25": ["3-10"] }), undefined);
    assert.equal(buildFragments("hola", { "../x": ["0-1"] }), undefined);
    assert.equal(buildFragments("hola", { "25": ["2-1", "a-b"] }), undefined);
  });
});
