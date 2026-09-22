/** Read bounded upstream/request bodies without buffering arbitrary payloads. */
export async function readJson(
  body: ReadableStream<Uint8Array> | null,
  limit: number,
): Promise<unknown> {
  if (!body) throw new Error("Missing JSON body");
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) throw new Error("JSON body too large");
      chunks.push(value);
    }
  } finally {
    await reader.cancel();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
}

export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

export function errorResponse(error: unknown, fallback: string): Response {
  return Response.json(
    { ok: false, error: error instanceof HttpError ? error.message : fallback },
    {
      status: error instanceof HttpError ? error.status : 502,
      headers: { "Cache-Control": "no-store" },
    },
  );
}
