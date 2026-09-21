/**
 * Credentials for MCP servers reached over HTTP, all of it in the OS keychain
 * (service `tedi`), never in `tedi-mcp-servers.json`:
 *
 * - Static headers (`Authorization: Bearer <token>`) for a server that takes a
 *   personal token, e.g. GitHub's remote MCP.
 * - OAuth for a server that signs you in (Linear, Sentry, Notion, ...). The MCP
 *   SDK runs the protocol: protected-resource discovery, dynamic client
 *   registration, PKCE, the token exchange and refresh. This file only gives it
 *   somewhere to keep the client registration and tokens, and a browser plus a
 *   loopback listener (`mcp_oauth_callback`) for the one step a person does.
 *
 * A sign-in only ever starts from Settings (adding or saving a server). During
 * an agent turn the provider refuses to open a browser: a turn must not throw a
 * login page at someone mid-thought, so it fails with what to do instead.
 */
import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import type { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import type {
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import { KEYRING_SERVICE } from "../config";

/**
 * Fixed, because a dynamically registered client is registered FOR its redirect
 * URI, and the registration is kept and reused. Loopback only.
 */
const OAUTH_PORT = 33418;
const REDIRECT_URL = `http://127.0.0.1:${OAUTH_PORT}/callback`;

const account = {
  headers: (server: string) => `mcp-headers:${server}`,
  tokens: (server: string) => `mcp-oauth-tokens:${server}`,
  client: (server: string) => `mcp-oauth-client:${server}`,
};

async function readSecret<T>(key: string): Promise<T | undefined> {
  try {
    const raw = await invoke<string | null>("secrets_get", {
      service: KEYRING_SERVICE,
      account: key,
    });
    return raw ? (JSON.parse(raw) as T) : undefined;
  } catch {
    return undefined;
  }
}

async function writeSecret(key: string, value: unknown): Promise<void> {
  await invoke("secrets_set", {
    service: KEYRING_SERVICE,
    account: key,
    password: JSON.stringify(value),
  });
}

async function deleteSecret(key: string): Promise<void> {
  try {
    await invoke("secrets_delete", { service: KEYRING_SERVICE, account: key });
  } catch {
    // already absent
  }
}

/** Extra request headers for an HTTP server (empty when none were set). */
export async function getMcpHeaders(server: string): Promise<Record<string, string>> {
  return (await readSecret<Record<string, string>>(account.headers(server))) ?? {};
}

export async function setMcpHeaders(
  server: string,
  headers: Record<string, string>,
): Promise<void> {
  if (Object.keys(headers).length === 0) await deleteSecret(account.headers(server));
  else await writeSecret(account.headers(server), headers);
}

/** Forget everything stored for a server: headers, tokens and its client registration. */
export async function clearMcpAuth(server: string): Promise<void> {
  await Promise.all([
    deleteSecret(account.headers(server)),
    deleteSecret(account.tokens(server)),
    deleteSecret(account.client(server)),
  ]);
}

/** `Name: value` lines <-> a header map, for the Settings field. */
export function parseHeaderLines(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const colon = t.indexOf(":");
    if (colon <= 0) continue;
    out[t.slice(0, colon).trim()] = t.slice(colon + 1).trim();
  }
  return out;
}

export function headerLines(headers: Record<string, string>): string {
  return Object.entries(headers)
    .map(([k, v]) => `${k}: ${v}`)
    .join("\n");
}

function randomState(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * The SDK's view of one server's OAuth state. `interactive` decides whether a
 * needed sign-in opens the browser (Settings) or fails with instructions (an
 * agent turn). After a redirect, `pendingCode` resolves with the authorization
 * code the browser brought back, for `transport.finishAuth`.
 */
export class McpOAuthProvider implements OAuthClientProvider {
  pendingCode: Promise<string> | null = null;
  private verifier = "";
  private expectedState = "";

  constructor(
    private readonly server: string,
    private readonly interactive: boolean,
  ) {}

  get redirectUrl(): string {
    return REDIRECT_URL;
  }

  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: "TEDI",
      redirect_uris: [REDIRECT_URL],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    };
  }

  state(): string {
    this.expectedState = randomState();
    return this.expectedState;
  }

  clientInformation(): Promise<OAuthClientInformationMixed | undefined> {
    return readSecret(account.client(this.server));
  }

  saveClientInformation(info: OAuthClientInformationMixed): Promise<void> {
    return writeSecret(account.client(this.server), info);
  }

  tokens(): Promise<OAuthTokens | undefined> {
    return readSecret(account.tokens(this.server));
  }

  saveTokens(tokens: OAuthTokens): Promise<void> {
    return writeSecret(account.tokens(this.server), tokens);
  }

  async redirectToAuthorization(url: URL): Promise<void> {
    if (!this.interactive) {
      throw new Error(
        `"${this.server}" needs you to sign in. Open Settings > Agents > MCP Servers, edit it and press Save to sign in.`,
      );
    }
    const expected = this.expectedState;
    // Listen BEFORE opening the browser, so a fast redirect cannot miss us.
    this.pendingCode = invoke<string>("mcp_oauth_callback", { port: OAUTH_PORT }).then((target) =>
      codeFromCallback(target, expected),
    );
    // Surface a listener failure (port taken) on the pending code, not here: the
    // SDK is about to throw UnauthorizedError and the caller awaits the code.
    this.pendingCode.catch(() => {});
    await openUrl(url.toString());
  }

  saveCodeVerifier(verifier: string): void {
    this.verifier = verifier;
  }

  codeVerifier(): string {
    return this.verifier;
  }

  async invalidateCredentials(scope: "all" | "client" | "tokens" | "verifier" | "discovery") {
    if (scope === "all" || scope === "tokens") await deleteSecret(account.tokens(this.server));
    if (scope === "all" || scope === "client") await deleteSecret(account.client(this.server));
    if (scope === "all" || scope === "verifier") this.verifier = "";
  }
}

/** The authorization code from a redirect target, after checking its state. Pure. */
export function codeFromCallback(target: string, expectedState: string): string {
  const q = new URL(target, "http://127.0.0.1").searchParams;
  const error = q.get("error_description") ?? q.get("error");
  if (error) throw new Error(`Sign-in was refused: ${error}`);
  // CSRF: the code is only ours if the state came back unchanged.
  if (expectedState && q.get("state") !== expectedState) {
    throw new Error("The sign-in callback did not match this attempt; try again.");
  }
  const code = q.get("code");
  if (!code) throw new Error("The sign-in callback carried no authorization code.");
  return code;
}
