import { existsSync, readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import { config } from "./config";

let client: postgres.Sql | undefined;

export function sql(): postgres.Sql {
  client ??= postgres(config().DATABASE_URL, { max: 10, onnotice: () => {} });
  return client;
}

/** The main schema, then each file of `schema/` in name order. Every statement must be safe to run again. */
export async function migrate() {
  await sql().unsafe(readFileSync(fileURLToPath(new URL("./schema.sql", import.meta.url)), "utf8"));
  const dir = fileURLToPath(new URL("./schema/", import.meta.url));
  if (!existsSync(dir)) return;
  for (const f of readdirSync(dir).filter((x) => x.endsWith(".sql")).sort()) await sql().unsafe(readFileSync(`${dir}${f}`, "utf8"));
}

export async function ensureUser(id: string) {
  await sql()`insert into users (id) values (${id}) on conflict do nothing`;
}
