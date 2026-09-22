/** Wait only on reads: a new HAPI contract can reach consensus before relay indexing. */
export async function waitForIndexedContract<T>(
  provider: { getCode(address: string): Promise<string> },
  address: string,
  read: () => Promise<T>,
  timeoutMs = 60_000,
  pollIntervalMs = 2_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  const message = `Contract ${address} was created but its relay reads are not ready after ${timeoutMs}ms. Retry deploy with the saved deployment record; no new contract is needed.`;
  while (Date.now() < deadline) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        (async () => {
          const code = await provider.getCode(address);
          if (!code || code === "0x") throw new Error("Relay has not indexed contract bytecode");
          return read();
        })(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error(message)), Math.max(1, deadline - Date.now()));
        }),
      ]);
    } catch {
      // Missing code, empty ABI data and transient relay failures are read-only retries.
      if (Date.now() >= deadline) break;
    } finally {
      if (timer) clearTimeout(timer);
    }
    await new Promise((resolve) => setTimeout(resolve, Math.min(pollIntervalMs, Math.max(0, deadline - Date.now()))));
  }
  throw new Error(message);
}
