import pkg from "pg";
const { Pool } = pkg;

export const pool = new Pool(
  process.env.DATABASE_URL
    ? {
        connectionString: process.env.DATABASE_URL,
        ssl: { rejectUnauthorized: false } // Neon richiede SSL
      }
    : {
        user: "gionabarbieri",
        host: "localhost",
        database: "nfc_event_system",
        password: "",
        port: 5432
      }
);