import { mkdtemp, realpath } from "node:fs/promises";
import { join } from "node:path";

// Managed Unix sockets need a physical path with room for the nested install layout.
export async function makeSocketFixtureRoot(prefix) {
  return mkdtemp(join(await realpath("/tmp"), prefix));
}
