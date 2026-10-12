import { and, eq } from "drizzle-orm";
import { measurementSignals, measurements } from "@/db/schema";
import { EXTRACTOR_VERSION } from "@/core/signals/extract";

/**
 * Join condition for a measurement's signals from the current extractor. `measurement_signals` holds one row
 * per extractor version, so a reader that joins on the measurement id alone counts a re-extracted measurement
 * twice. Bumping EXTRACTOR_VERSION therefore means re-extracting the stored answers first.
 */
export const currentSignals = and(
  eq(measurementSignals.measurementId, measurements.id),
  eq(measurementSignals.extractorVersion, EXTRACTOR_VERSION),
)!;
