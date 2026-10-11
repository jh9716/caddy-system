/**
 * Print hostname of an isolated preview296 DATABASE_URL.
 * Refuses Production Neon. Does not print the URL.
 */
const url = String(process.env.PREVIEW296_DATABASE_URL || process.env.DATABASE_URL || "").trim();
if (!url) {
  console.error("preview296 DATABASE_URL missing");
  process.exit(1);
}
let host = "";
try {
  host = new URL(url).hostname.toLowerCase();
} catch {
  console.error("preview296 DATABASE_URL is not a URL");
  process.exit(1);
}
if (!host || host === "localhost" || host === "127.0.0.1") {
  console.error("preview296 DATABASE_URL must not be localhost");
  process.exit(1);
}
if (host.includes("ep-crimson-cell-a1i1tpce")) {
  console.error("⛔ preview296 DATABASE_URL is production Neon. stop.");
  process.exit(1);
}
process.stdout.write(host);
