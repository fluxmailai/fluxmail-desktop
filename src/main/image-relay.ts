import { z } from "zod";
import { normalizeRemoteImageUrl } from "../shared/image-relay";

export const IMAGE_RELAY_SIGN_ENDPOINT = "https://fluxmail.ai/api/image-proxy/sign";
export const IMAGE_RELAY_TOKEN_ENDPOINT = "https://fluxmail.ai/api/v1/image-relay/token";
export const IMAGE_RELAY_ORIGIN = "https://cdn.fluxmail.workers.dev";

const MAX_URLS_PER_REQUEST = 50;
const MAX_CACHED_URLS = 5_000;
const relayUrlSchema = z.url().refine((value) => new URL(value).origin === IMAGE_RELAY_ORIGIN);
const signedResponseSchema = z.object({
  signedUrls: z.record(z.string(), relayUrlSchema),
  requestedUrls: z.record(z.string(), relayUrlSchema),
  expiresAt: z.number().int().positive(),
});
const accessTokenResponseSchema = z.object({
  accessToken: z.string().min(1),
  expiresAt: z.string().refine((value) => Number.isFinite(Date.parse(value))),
});

type RelayFetch = (input: string, init: RequestInit) => Promise<Response>;

export class HostedImageRelayAccess {
  private cached?: { accessToken: string; expiresAt: number };
  private pending?: Promise<string>;

  constructor(
    private readonly licenseLease: (forceRefresh?: boolean) => Promise<string>,
    private readonly fetch: RelayFetch,
    private readonly onAccessDenied: () => void = () => undefined,
    private readonly endpoint = IMAGE_RELAY_TOKEN_ENDPOINT,
  ) {}

  async token(forceRefresh = false): Promise<string> {
    if (!forceRefresh && this.cached && this.cached.expiresAt > Date.now() + 60_000) {
      return this.cached.accessToken;
    }

    if (this.pending) return this.pending;

    const request = this.fetchToken(forceRefresh);
    this.pending = request;
    try {
      return await request;
    } finally {
      if (this.pending === request) this.pending = undefined;
    }
  }

  private async fetchToken(forceRefresh: boolean): Promise<string> {
    let response = await this.exchange(forceRefresh);
    if (response.status === 401 && !forceRefresh) response = await this.exchange(true);
    if (response.status === 403) this.onAccessDenied();
    if (!response.ok) throw relayAccessError(response.status);

    const access = accessTokenResponseSchema.parse(await response.json());
    const expiresAt = Date.parse(access.expiresAt);
    if (expiresAt <= Date.now()) throw new Error("Fluxmail returned an expired image relay token.");
    this.cached = { accessToken: access.accessToken, expiresAt };
    return access.accessToken;
  }

  private async exchange(forceRefresh: boolean): Promise<Response> {
    const lease = await this.licenseLease(forceRefresh);
    return this.fetch(this.endpoint, {
      method: "POST",
      headers: { Authorization: `License ${lease}` },
    });
  }
}

export class HostedImageRelay {
  private readonly cache = new Map<string, { proxyUrl: string; expiresAt: number }>();

  constructor(
    private readonly accessToken: (forceRefresh?: boolean) => Promise<string>,
    private readonly fetch: RelayFetch,
    private readonly endpoint = IMAGE_RELAY_SIGN_ENDPOINT,
    private readonly maxCacheEntries = MAX_CACHED_URLS,
  ) {}

  async proxy(rawUrls: string[]): Promise<Record<string, string>> {
    const urls = [...new Set(rawUrls.flatMap((url) => normalizeRemoteImageUrl(url) ?? []))];
    const result: Record<string, string> = {};
    const missing: string[] = [];
    const now = Date.now();

    for (const [url, cached] of this.cache) {
      if (cached.expiresAt * 1000 <= now + 60_000) this.cache.delete(url);
    }

    for (const url of urls) {
      const cached = this.cache.get(url);
      if (cached) {
        this.cache.delete(url);
        this.cache.set(url, cached);
        result[url] = cached.proxyUrl;
      } else missing.push(url);
    }

    if (!missing.length) return result;
    let token = await this.accessToken();
    for (let offset = 0; offset < missing.length; offset += MAX_URLS_PER_REQUEST) {
      const batch = missing.slice(offset, offset + MAX_URLS_PER_REQUEST);
      let signed = await this.sign(batch, token);
      if (!signed) {
        token = await this.accessToken(true);
        signed = await this.sign(batch, token);
      }
      if (!signed) throw relayResponseError(401);

      for (const [url, proxyUrl] of Object.entries(signed.requestedUrls)) {
        if (!batch.includes(url)) continue;
        this.cache.delete(url);
        this.cache.set(url, { proxyUrl, expiresAt: signed.expiresAt });
        this.trimCache();
        result[url] = proxyUrl;
      }
    }

    return result;
  }

  private trimCache(): void {
    while (this.cache.size > this.maxCacheEntries) {
      const oldest = this.cache.keys().next().value;
      if (oldest === undefined) return;
      this.cache.delete(oldest);
    }
  }

  private async sign(
    urls: string[],
    token: string,
  ): Promise<z.infer<typeof signedResponseSchema> | undefined> {
    const response = await this.fetch(this.endpoint, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ urls }),
    });
    if (response.status === 401) return undefined;
    if (!response.ok) throw relayResponseError(response.status);
    return signedResponseSchema.parse(await response.json());
  }
}

function relayAccessError(status: number): Error {
  if (status === 403)
    return new Error("Private image relay is available on Pro, Team, and Enterprise.");
  if (status === 401)
    return new Error("Fluxmail could not renew private image relay access. Check your license.");
  if (status === 429) return new Error("Too many private image relay requests. Try again shortly.");
  return new Error(`Fluxmail could not start the private image relay (HTTP ${status}).`);
}

function relayResponseError(status: number): Error {
  if (status === 401)
    return new Error("Fluxmail could not verify private image relay access. Check your license.");
  if (status === 501) return new Error("The Fluxmail image relay is not available right now.");
  return new Error(`The Fluxmail image relay returned HTTP ${status}.`);
}
