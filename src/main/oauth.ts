import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { OAuth2Client, type Credentials } from "google-auth-library";

export const GMAIL_MODIFY_SCOPE = "https://www.googleapis.com/auth/gmail.modify";
export const GMAIL_FULL_ACCESS_SCOPE = "https://mail.google.com/";
const GOOGLE_IDENTITY_SCOPES = ["openid", "email", "profile"];
export const GMAIL_SCOPES = [GMAIL_MODIFY_SCOPE, ...GOOGLE_IDENTITY_SCOPES];
export const CUSTOM_GMAIL_SCOPES = [GMAIL_FULL_ACCESS_SCOPE, ...GOOGLE_IDENTITY_SCOPES];
const OAUTH_LOOPBACK_HOST = "127.0.0.1";

export interface GoogleIdentity {
  email: string;
  displayName?: string;
  tokens: Credentials;
  canPermanentlyDelete: boolean;
}

export async function runGoogleOAuth(input: {
  clientId: string;
  clientSecret: string;
  port: number;
  allowPermanentDelete: boolean;
  openExternal(url: string): Promise<void>;
}): Promise<GoogleIdentity> {
  const redirectUri = googleOAuthRedirectUri(input.port);
  const client = new OAuth2Client({
    clientId: input.clientId,
    clientSecret: input.clientSecret,
    redirectUri,
  });
  const state = randomBytes(24).toString("hex");
  const scopes = googleOAuthScopes(input.allowPermanentDelete);
  const authUrl = client.generateAuthUrl({
    access_type: "offline",
    prompt: "consent",
    scope: scopes,
    state,
  });

  return waitForOAuthCallback({
    providerName: "Google",
    host: OAUTH_LOOPBACK_HOST,
    port: input.port,
    callbackPath: "/oauth/callback",
    redirectUri,
    state,
    authUrl,
    openExternal: input.openExternal,
    complete: async (code) => {
      const { tokens } = await client.getToken(code);
      if (!tokens.refresh_token) {
        throw new Error(
          "Google did not return a refresh token. Remove Fluxmail from Google account access and try again.",
        );
      }
      if (!tokens.id_token) throw new Error("Google did not return an identity token.");
      const ticket = await client.verifyIdToken({
        idToken: tokens.id_token,
        audience: input.clientId,
      });
      const payload = ticket.getPayload();
      if (!payload?.email || !payload.email_verified)
        throw new Error("Google did not return a verified email address.");
      const grantedTokens = googleCredentialsWithGrantedScopes(tokens, scopes);
      return {
        email: payload.email,
        ...(payload.name ? { displayName: payload.name } : {}),
        tokens: grantedTokens,
        canPermanentlyDelete: googleCredentialsAllowPermanentDelete(grantedTokens, scopes),
      };
    },
  });
}

export interface MicrosoftOAuthApp {
  clientId: string;
  clientSecret?: string;
  tenantId: string;
}

/** Matches the credential shape the Fluxmail engine stores for Outlook accounts. */
export interface MicrosoftCredentials {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  scope?: string;
  clientAuth: "public";
  fluxmailOAuthClient: MicrosoftOAuthApp;
}

export interface MicrosoftIdentity {
  email: string;
  displayName?: string;
  credentials: MicrosoftCredentials;
}

export const MICROSOFT_SCOPES = [
  "openid",
  "profile",
  "email",
  "offline_access",
  "User.Read",
  "Mail.ReadWrite",
  "Mail.Send",
  "MailboxSettings.Read",
];

/**
 * Loopback PKCE sign-in for a public Microsoft Entra client, the same flow the
 * Fluxmail CLI uses. The app registration needs this redirect URI under
 * "Mobile and desktop applications".
 */
export async function runMicrosoftOAuth(input: {
  app: MicrosoftOAuthApp;
  host: string;
  port: number;
  openExternal(url: string): Promise<void>;
  fetch?: typeof fetch;
}): Promise<MicrosoftIdentity> {
  const request = input.fetch ?? fetch;
  const app = { ...input.app };
  const redirectUri = microsoftOAuthRedirectUri(input.port);
  const state = randomBytes(24).toString("hex");
  const verifier = randomBytes(48).toString("base64url");
  const authUrl = new URL(microsoftEndpoint(app.tenantId, "authorize"));
  authUrl.search = new URLSearchParams({
    client_id: app.clientId,
    response_type: "code",
    redirect_uri: redirectUri,
    response_mode: "query",
    scope: MICROSOFT_SCOPES.join(" "),
    state,
    code_challenge: createHash("sha256").update(verifier).digest("base64url"),
    code_challenge_method: "S256",
    prompt: "select_account",
  }).toString();

  return waitForOAuthCallback({
    providerName: "Microsoft",
    host: input.host,
    port: input.port,
    callbackPath: MICROSOFT_CALLBACK_PATH,
    redirectUri,
    state,
    authUrl: authUrl.toString(),
    openExternal: input.openExternal,
    complete: (code) => exchangeMicrosoftCode({ app, code, redirectUri, verifier, fetch: request }),
  });
}

export async function exchangeMicrosoftCode(input: {
  app: MicrosoftOAuthApp;
  code: string;
  redirectUri: string;
  verifier: string;
  fetch?: typeof fetch;
}): Promise<MicrosoftIdentity> {
  const request = input.fetch ?? fetch;
  const tokenResponse = await request(microsoftEndpoint(input.app.tenantId, "token"), {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: input.app.clientId,
      grant_type: "authorization_code",
      code: input.code,
      redirect_uri: input.redirectUri,
      code_verifier: input.verifier,
      scope: MICROSOFT_SCOPES.join(" "),
    }),
  });
  const token = (await readJson(tokenResponse)) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
    scope?: string;
    error?: string;
    error_description?: string;
  };
  if (!tokenResponse.ok || token.error) {
    throw new Error(
      `Microsoft sign-in failed: ${firstLine(token.error_description) ?? token.error ?? `HTTP ${tokenResponse.status}`}`,
    );
  }
  if (!token.access_token) throw new Error("Microsoft did not return an access token.");
  if (!token.refresh_token) {
    throw new Error("Microsoft did not return a refresh token. Try connecting the account again.");
  }

  const graph = (path: string) =>
    request(`https://graph.microsoft.com/v1.0${path}`, {
      headers: { authorization: `Bearer ${token.access_token}`, accept: "application/json" },
    });
  const profileResponse = await graph("/me?$select=mail,userPrincipalName,displayName");
  const profile = (await readJson(profileResponse)) as {
    mail?: string | null;
    userPrincipalName?: string;
    displayName?: string;
    error?: { message?: string };
  };
  if (!profileResponse.ok) {
    throw new Error(
      `Microsoft could not read the signed-in account: ${profile.error?.message ?? `HTTP ${profileResponse.status}`}`,
    );
  }
  const email = profile.mail?.trim() || profile.userPrincipalName?.trim();
  if (!email) throw new Error("Microsoft did not return a mailbox address.");

  const inboxResponse = await graph("/me/mailFolders/inbox?$select=id");
  const inbox = (await readJson(inboxResponse)) as { id?: string; error?: { message?: string } };
  if (!inboxResponse.ok || !inbox.id) {
    throw new Error(
      `Microsoft could not open the mailbox for ${email}: ${inbox.error?.message ?? `HTTP ${inboxResponse.status}`}`,
    );
  }

  const displayName = profile.displayName?.trim();
  return {
    email,
    ...(displayName ? { displayName } : {}),
    credentials: {
      accessToken: token.access_token,
      refreshToken: token.refresh_token,
      expiresAt: Date.now() + Math.max(token.expires_in ?? 3_600, 60) * 1_000,
      clientAuth: "public",
      fluxmailOAuthClient: input.app,
      ...(token.scope ? { scope: token.scope } : {}),
    },
  };
}

export function microsoftOAuthRedirectUri(port: number): string {
  return `http://localhost:${port}${MICROSOFT_CALLBACK_PATH}`;
}

const MICROSOFT_CALLBACK_PATH = "/oauth/microsoft/callback";

function microsoftEndpoint(tenantId: string, path: "authorize" | "token"): string {
  return `https://login.microsoftonline.com/${encodeURIComponent(tenantId)}/oauth2/v2.0/${path}`;
}

async function readJson(response: Response): Promise<Record<string, unknown>> {
  try {
    return (await response.json()) as Record<string, unknown>;
  } catch {
    return {};
  }
}

/** Microsoft error descriptions append trace and correlation IDs on later lines. */
function firstLine(value: string | undefined): string | undefined {
  return value?.split(/\r?\n/)[0]?.trim() || undefined;
}

/**
 * Listens once on the loopback redirect, opens the consent page, and resolves
 * with the result of exchanging the returned authorization code.
 */
function waitForOAuthCallback<T extends { email: string }>(input: {
  providerName: string;
  host: string;
  port: number;
  callbackPath: string;
  redirectUri: string;
  state: string;
  authUrl: string;
  openExternal(url: string): Promise<void>;
  complete(code: string): Promise<T>;
}): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const settle = (callback: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      server.close();
      server.closeAllConnections();
      callback();
    };
    const server = createServer(async (request, response) => {
      try {
        const url = new URL(request.url ?? "/", input.redirectUri);
        if (url.pathname !== input.callbackPath) {
          response.writeHead(404).end("Not found");
          return;
        }
        if (!isOAuthStateValid(input.state, url.searchParams.get("state"))) {
          response
            .writeHead(400)
            .end("The sign-in request did not match. Return to Fluxmail and try again.");
          return;
        }
        const oauthError = url.searchParams.get("error");
        if (oauthError) {
          const description = firstLine(url.searchParams.get("error_description") ?? undefined);
          throw new Error(`${input.providerName} sign-in failed: ${description ?? oauthError}`);
        }
        const code = url.searchParams.get("code");
        if (!code) throw new Error(`${input.providerName} did not return an authorization code.`);
        const result = await input.complete(code);
        response
          .writeHead(200, { "content-type": "text/html; charset=utf-8" })
          .end(successPage(result.email));
        response.once("close", () => settle(() => resolve(result)));
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "Fluxmail could not connect this account.";
        response
          .writeHead(400, { "content-type": "text/html; charset=utf-8" })
          .end(errorPage(message));
        response.once("close", () => settle(() => reject(error)));
      }
    });
    const timeout = setTimeout(
      () =>
        settle(() =>
          reject(
            new Error(`${input.providerName} sign-in timed out. Try connecting the account again.`),
          ),
        ),
      10 * 60_000,
    );
    server.once("error", (error: NodeJS.ErrnoException) => {
      const resolved =
        error.code === "EADDRINUSE"
          ? new Error(
              `Port ${input.port} is already in use. Close the app using that port and try again.`,
            )
          : error;
      settle(() => reject(resolved));
    });
    server.listen(input.port, input.host, () => {
      void input.openExternal(input.authUrl).catch((error) => settle(() => reject(error)));
    });
  });
}

export function googleOAuthScopes(allowPermanentDelete: boolean): string[] {
  return allowPermanentDelete ? CUSTOM_GMAIL_SCOPES : GMAIL_SCOPES;
}

export function googleOAuthSourceAllowsPermanentDelete(
  source: "built-in" | "stored" | "environment" | "environment-file",
): boolean {
  return source !== "built-in";
}

export function googleCredentialsWithGrantedScopes(
  credentials: Credentials,
  requestedScopes: readonly string[],
): Credentials {
  return credentials.scope ? credentials : { ...credentials, scope: requestedScopes.join(" ") };
}

export function googleCredentialsAllowPermanentDelete(
  credentials: Credentials,
  requestedScopes: readonly string[],
): boolean {
  const grantedScopes = credentials.scope
    ? credentials.scope.split(/\s+/).filter(Boolean)
    : requestedScopes;
  return grantedScopes.includes(GMAIL_FULL_ACCESS_SCOPE);
}

export function googleOAuthRedirectUri(port: number): string {
  return `http://${OAUTH_LOOPBACK_HOST}:${port}/oauth/callback`;
}

export function isOAuthStateValid(expected: string, actual: string | null): boolean {
  return expected.length >= 32 && actual === expected;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => {
    const entities: Record<string, string> = {
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;",
    };
    return entities[character]!;
  });
}

function page(title: string, message: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${escapeHtml(title)}</title></head><body style="font-family:-apple-system,BlinkMacSystemFont,sans-serif;max-width:520px;margin:80px auto;padding:24px;color:#202124"><h2>${escapeHtml(title)}</h2><p>${escapeHtml(message)}</p></body></html>`;
}

function successPage(email: string): string {
  return page(`${email} is connected`, "You can close this tab and return to Fluxmail.");
}

function errorPage(message: string): string {
  return page("Fluxmail could not connect the account", message);
}
