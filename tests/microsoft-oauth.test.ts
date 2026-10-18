import { createServer } from "node:net";
import { describe, expect, it, vi } from "vitest";
import {
  exchangeMicrosoftCode,
  MICROSOFT_SCOPES,
  microsoftOAuthRedirectUri,
  runMicrosoftOAuth,
} from "../src/main/oauth";

const app = { clientId: "11111111-2222-3333-4444-555555555555", tenantId: "common" };

describe("Microsoft OAuth", () => {
  it("uses the redirect URI the Fluxmail CLI registers in Entra", () => {
    expect(microsoftOAuthRedirectUri(8976)).toBe("http://localhost:8976/oauth/microsoft/callback");
  });

  it("exchanges the code with PKCE and returns engine-compatible credentials", async () => {
    const fetch = graphFetch();
    const before = Date.now();

    const identity = await exchangeMicrosoftCode({
      app,
      code: "auth-code",
      redirectUri: microsoftOAuthRedirectUri(8976),
      verifier: "verifier",
      fetch,
    });

    expect(identity).toEqual({
      email: "me@outlook.com",
      displayName: "Me Example",
      credentials: {
        accessToken: "access-token",
        refreshToken: "refresh-token",
        expiresAt: expect.any(Number),
        scope: "Mail.ReadWrite Mail.Send",
        clientAuth: "public",
        fluxmailOAuthClient: app,
      },
    });
    expect(identity.credentials.expiresAt).toBeGreaterThanOrEqual(before + 3_600_000);
    const [tokenUrl, tokenInit] = fetch.mock.calls[0]!;
    expect(tokenUrl).toBe("https://login.microsoftonline.com/common/oauth2/v2.0/token");
    const body = new URLSearchParams(String(tokenInit?.body));
    expect(Object.fromEntries(body)).toEqual({
      client_id: app.clientId,
      grant_type: "authorization_code",
      code: "auth-code",
      redirect_uri: "http://localhost:8976/oauth/microsoft/callback",
      code_verifier: "verifier",
      scope: MICROSOFT_SCOPES.join(" "),
    });
    expect(body.has("client_secret")).toBe(false);
  });

  it("falls back to the user principal name when Graph has no mail address", async () => {
    const identity = await exchangeMicrosoftCode({
      app,
      code: "auth-code",
      redirectUri: microsoftOAuthRedirectUri(8976),
      verifier: "verifier",
      fetch: graphFetch({ profile: { mail: null, userPrincipalName: "me@contoso.com" } }),
    });
    expect(identity.email).toBe("me@contoso.com");
    expect(identity).not.toHaveProperty("displayName");
  });

  it("reports the first line of a Microsoft token error", async () => {
    await expect(
      exchangeMicrosoftCode({
        app,
        code: "auth-code",
        redirectUri: microsoftOAuthRedirectUri(8976),
        verifier: "verifier",
        fetch: graphFetch({
          token: {
            status: 400,
            body: {
              error: "invalid_client",
              error_description:
                "AADSTS7000218: The request body must contain client_secret.\r\nTrace ID: abc",
            },
          },
        }),
      }),
    ).rejects.toThrow(
      "Microsoft sign-in failed: AADSTS7000218: The request body must contain client_secret.",
    );
  });

  it("rejects accounts without a reachable mailbox", async () => {
    await expect(
      exchangeMicrosoftCode({
        app,
        code: "auth-code",
        redirectUri: microsoftOAuthRedirectUri(8976),
        verifier: "verifier",
        fetch: graphFetch({
          inbox: { status: 404, body: { error: { message: "The mailbox is not enabled." } } },
        }),
      }),
    ).rejects.toThrow("Microsoft could not open the mailbox for me@outlook.com");
  });

  it("completes the loopback flow when Microsoft redirects back", async () => {
    const port = await freePort();
    const fetch = graphFetch();
    let authUrl: URL | undefined;
    const result = runMicrosoftOAuth({
      app,
      host: "127.0.0.1",
      port,
      fetch,
      openExternal: async (url) => {
        authUrl = new URL(url);
      },
    });
    await vi.waitFor(() => expect(authUrl).toBeDefined());

    expect(authUrl!.origin + authUrl!.pathname).toBe(
      "https://login.microsoftonline.com/common/oauth2/v2.0/authorize",
    );
    expect(authUrl!.searchParams.get("redirect_uri")).toBe(microsoftOAuthRedirectUri(port));
    expect(authUrl!.searchParams.get("code_challenge_method")).toBe("S256");
    const state = authUrl!.searchParams.get("state")!;

    const wrongState = await globalThis.fetch(
      `http://127.0.0.1:${port}/oauth/microsoft/callback?code=x&state=wrong`,
    );
    expect(wrongState.status).toBe(400);

    const callback = await globalThis.fetch(
      `http://127.0.0.1:${port}/oauth/microsoft/callback?code=auth-code&state=${state}`,
    );
    expect(callback.status).toBe(200);
    expect(await callback.text()).toContain("me@outlook.com is connected");
    await expect(result).resolves.toMatchObject({ email: "me@outlook.com" });

    const tokenBody = new URLSearchParams(String(fetch.mock.calls[0]![1]?.body));
    expect(tokenBody.get("code")).toBe("auth-code");
    expect(tokenBody.get("code_verifier")).toMatch(/^[\w-]{43,128}$/);
  });

  it("rejects the flow when the user cancels sign-in", async () => {
    const port = await freePort();
    let authUrl: URL | undefined;
    const result = runMicrosoftOAuth({
      app,
      host: "127.0.0.1",
      port,
      fetch: graphFetch(),
      openExternal: async (url) => {
        authUrl = new URL(url);
      },
    });
    const rejection = expect(result).rejects.toThrow(
      "Microsoft sign-in failed: The user canceled the sign-in.",
    );
    await vi.waitFor(() => expect(authUrl).toBeDefined());
    const state = authUrl!.searchParams.get("state")!;

    await globalThis.fetch(
      `http://127.0.0.1:${port}/oauth/microsoft/callback?error=access_denied&error_description=${encodeURIComponent("The user canceled the sign-in.")}&state=${state}`,
    );
    await rejection;
  });
});

function graphFetch(
  overrides: {
    token?: { status: number; body: unknown };
    profile?: Record<string, unknown>;
    inbox?: { status: number; body: unknown };
  } = {},
) {
  return vi.fn(async (input: string | URL | Request, _init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/oauth2/v2.0/token")) {
      const token = overrides.token ?? {
        status: 200,
        body: {
          access_token: "access-token",
          refresh_token: "refresh-token",
          expires_in: 3_600,
          scope: "Mail.ReadWrite Mail.Send",
        },
      };
      return Response.json(token.body, { status: token.status });
    }
    if (url.startsWith("https://graph.microsoft.com/v1.0/me?")) {
      return Response.json({
        mail: "me@outlook.com",
        userPrincipalName: "me_outlook.com#EXT#@contoso.onmicrosoft.com",
        ...(overrides.profile ?? { displayName: "Me Example" }),
      });
    }
    if (url.startsWith("https://graph.microsoft.com/v1.0/me/mailFolders/inbox")) {
      const inbox = overrides.inbox ?? { status: 200, body: { id: "inbox-id" } };
      return Response.json(inbox.body, { status: inbox.status });
    }
    throw new Error(`Unexpected request to ${url}`);
  });
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() =>
        typeof address === "object" && address ? resolve(address.port) : reject(new Error()),
      );
    });
  });
}
