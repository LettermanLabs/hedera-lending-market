import { mkdir, readFile, writeFile, rename, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";

type Entry =
  | { state: "pending"; transactionId?: string }
  | { state: "submitted"; sequence: string };
export type Reservation = Entry | { state: "reserved" } | { state: "limited" };
const exists = (error: unknown) =>
  (error as NodeJS.ErrnoException).code === "EEXIST";

/** Shared-volume journal that prevents resubmission when a transaction's outcome is unknown. */
export class ActivityStore {
  private root: string;
  constructor(
    directory: string,
    scope: string,
    private hourlyLimit = 30,
  ) {
    this.root = join(
      directory,
      createHash("sha256").update(scope).digest("hex"),
    );
  }
  private entry(hash: string) {
    if (!/^0x[0-9a-f]{64}$/.test(hash))
      throw new Error("Invalid transaction hash");
    return join(this.root, hash);
  }
  async reserve(hash: string, now = Date.now()): Promise<Reservation> {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const entry = this.entry(hash);
    try {
      await mkdir(entry, { mode: 0o700 });
    } catch (error) {
      if (!exists(error)) throw error;
      try {
        return JSON.parse(
          await readFile(join(entry, "state.json"), "utf8"),
        ) as Entry;
      } catch {
        return { state: "pending" };
      }
    }
    const hour = Math.floor(now / 3_600_000);
    // Atomic slots bound spend across processes sharing this volume, including ambiguous outcomes.
    for (let slot = 0; slot < this.hourlyLimit; slot++) {
      try {
        await mkdir(join(this.root, `quota-${hour}-${slot}`), { mode: 0o700 });
        await this.save(hash, { state: "pending" });
        return { state: "reserved" };
      } catch (error) {
        if (!exists(error)) throw error;
      }
    }
    await rm(entry, { recursive: true }); // Release this unsubmitted reservation.
    return { state: "limited" };
  }
  async save(hash: string, entry: Entry) {
    const directory = this.entry(hash);
    await writeFile(join(directory, "state.tmp"), JSON.stringify(entry), {
      mode: 0o600,
    });
    await rename(join(directory, "state.tmp"), join(directory, "state.json"));
  }
}
