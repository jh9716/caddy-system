/**
 * Read-only marshal P1–P3 production inspect.
 * Never writes. Never runs migrate deploy / resolve / db execute.
 *
 *   DATABASE_URL="$PRODUCTION_DATABASE_URL" \
 *     npm run inspect:marshal-p1p3-readonly
 */
import { runMarshalPenaltyMaint } from "./maintenance/marshalPenaltyMaint";

if (process.argv.includes("--apply") || process.argv.includes("--sync-checksums")) {
  console.error("HOLD: inspect-marshal-penalty-p1p3-prod-readonly refuses apply/sync");
  process.exit(1);
}

runMarshalPenaltyMaint({ argv: ["--inspect"], env: process.env })
  .then((code) => {
    process.exit(code);
  })
  .catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  });
