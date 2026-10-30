import "./neon-local";
import { neon } from "@neondatabase/serverless";

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL is not set. Run pnpm db:local and use its environment lines.");
}

export const sql = neon(process.env.DATABASE_URL);
