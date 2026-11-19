import type { Room } from "@tetraboard/protocol";

export interface AiServiceBindings {
  AI_RATED_ONLY?: string;
  FOUR_SHOGI_DIAGNOSTICS?: string;
  AI_SERVICE_URL?: string;
  AI_GATEWAY?: Pick<Fetcher, "fetch">;
  AI_SERVICE_TOKEN?: string;
  AI_SERVICE_TIMEOUT_MS?: string;
  AI_FOUR_REVERSI_TIMEOUT_MS?: string;
  AI_SERVICE_LEVEL2_PROFILE?: string;
  AI_SERVICE_LEVEL2_LIMITS?: string;
  AI_SHOGI_ENABLED?: string;
  AI_REVERSI_ENABLED?: string;
}

export const roomAiAllowed = (bindings: AiServiceBindings, room: Room) => {
  const context = "matchmaking" in room ? room.matchmaking : undefined;
  // 二人ゲームの専用ルームはすべてレート戦で、旧四人ランダムマッチだけは対象外です。
  return (
    bindings.AI_RATED_ONLY !== "true" ||
    (!!context && (("rated" in context && context.rated === true) || "opponent" in context))
  );
};

export const aiServiceEnabled = (bindings: AiServiceBindings) =>
  Boolean(bindings.AI_GATEWAY || bindings.AI_SERVICE_URL);
export function aiServiceTimeout(bindings: AiServiceBindings): number {
  const value = Number(bindings.AI_SERVICE_TIMEOUT_MS || 5000);
  return Number.isInteger(value) && value >= 100 && value <= 5000 ? value : 5000;
}

export function fourReversiAiServiceTimeout(bindings: AiServiceBindings): number {
  const value = Number(bindings.AI_FOUR_REVERSI_TIMEOUT_MS);
  return Number.isInteger(value) && value >= 100 && value <= 10_000
    ? value
    : aiServiceTimeout(bindings);
}

export function configuredUrl(bindings: AiServiceBindings): URL | null {
  const token = bindings.AI_SERVICE_TOKEN;
  if (!token || token.length < 32 || token.length > 256 || !/^[\x21-\x7e]+$/.test(token))
    return null;
  if (bindings.AI_GATEWAY) return new URL("https://ai-gateway.internal");

  let url: URL;
  try {
    url = new URL(bindings.AI_SERVICE_URL ?? "");
    if (
      (url.protocol !== "https:" &&
        !(
          url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
        )) ||
      url.username ||
      url.password ||
      url.pathname !== "/" ||
      url.search ||
      url.hash
    )
      throw Error();
  } catch {
    return null;
  }
  return url;
}
export const aiServiceConfigured = (bindings: AiServiceBindings) =>
  configuredUrl(bindings) !== null;

export function fetchAiGateway(bindings: AiServiceBindings, url: URL, init: RequestInit) {
  return bindings.AI_GATEWAY ? bindings.AI_GATEWAY.fetch(new Request(url, init)) : fetch(url, init);
}

export class ServiceError extends Error {
  constructor(
    readonly reason: string,
    readonly retryable = false,
  ) {
    super(reason);
  }
}

export async function responseJson(response: Response): Promise<unknown> {
  const reader = response.body?.getReader();
  if (!reader) throw new ServiceError("invalid_response");
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 8192) throw new ServiceError("response_too_large");
      chunks.push(value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.length;
    }
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error instanceof ServiceError ? error : new ServiceError("invalid_response");
  } finally {
    reader.releaseLock();
  }
}
