// "Was this module started as the script?" check shared by the fetch_*.mjs CLIs.
import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";

/**
 * True when moduleUrl (import.meta.url) is the script node was started with (argv[1]).
 * In the packaged app argv[1] is not a script but the exe's first argument (for example
 * "--er-swap-from=C:\...\old.exe" after a program update), so a path that cannot be
 * resolved is not this module: false instead of the realpath (lstat) error.
 */
export function isMain(moduleUrl, argv = process.argv) {
  if (!argv[1]) return false;
  let file;
  try {
    file = realpathSync(argv[1]);
  } catch {
    return false;
  }
  return moduleUrl === pathToFileURL(file).href;
}
