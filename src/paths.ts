// Carpeta raíz de la app: la que tiene el package.json. En desarrollo es la del proyecto; en la
// app empaquetada es la raíz del archivo app.asar. Se busca subiendo desde este archivo, así
// funciona igual con los .ts de src/ que con los .js compilados de dist/backend/.

import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

function findRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  while (!existsSync(join(dir, "package.json"))) {
    const parent = dirname(dir);
    if (parent === dir) throw new Error("No se encontró la carpeta de la app (package.json).");
    dir = parent;
  }
  return dir;
}

export const APP_ROOT = findRoot();
