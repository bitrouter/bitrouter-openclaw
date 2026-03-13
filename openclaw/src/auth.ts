/**
 * Ed25519 keypair generation and JWT minting for BitRouter auth.
 *
 * BitRouter authenticates API requests via EdDSA-signed JWTs. This module
 * generates an Ed25519 keypair in BitRouter's key format and mints JWTs
 * that the plugin uses to authenticate with the local BitRouter instance.
 *
 * Key format (from bitrouter-core/src/jwt/keys.rs):
 *   master.json: { "algorithm": "eddsa", "secret_key": "<base64url(seed+pubkey)>" }
 *   The 64-byte secret is 32-byte seed + 32-byte public key, base64url-encoded.
 *
 * JWT format (from bitrouter-core/src/jwt/token.rs):
 *   base64url(header).base64url(claims).base64url(signature), no padding.
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

// ── Base64url helpers ─────────────────────────────────────────────────

function base64urlEncode(buf: Buffer): string {
  return buf.toString("base64url");
}

function base64urlDecode(str: string): Buffer {
  return Buffer.from(str, "base64url");
}

// ── Keypair generation ────────────────────────────────────────────────

export interface Ed25519Keypair {
  publicKey: Buffer;
  privateKey: Buffer;
}

/**
 * Generate a new Ed25519 keypair.
 *
 * Returns raw key buffers: privateKey is the 32-byte seed,
 * publicKey is the 32-byte public key.
 */
export function generateKeypair(): Ed25519Keypair {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519", {
    publicKeyEncoding: { type: "spki", format: "der" },
    privateKeyEncoding: { type: "pkcs8", format: "der" },
  });

  // Extract raw 32-byte keys from DER encoding.
  // Ed25519 SPKI DER: 12-byte header + 32-byte public key
  // Ed25519 PKCS8 DER: 16-byte header + 34-byte wrapper (2-byte prefix + 32-byte seed)
  const rawPublic = publicKey.subarray(publicKey.length - 32);
  const rawPrivate = privateKey.subarray(privateKey.length - 32);

  return {
    publicKey: Buffer.from(rawPublic),
    privateKey: Buffer.from(rawPrivate),
  };
}

// ── Keypair persistence ───────────────────────────────────────────────

/** Key prefix used for BitRouter's key directory structure. */
const KEY_PREFIX = "openclaw";

/**
 * Save an Ed25519 keypair to BitRouter's key directory format.
 *
 * Writes:
 *   <homeDir>/.keys/<prefix>/master.json — the key in BitRouter format
 *   <homeDir>/.keys/active — the active key prefix
 */
export function saveKeypair(
  homeDir: string,
  publicKey: Buffer,
  privateKey: Buffer
): void {
  const keysDir = path.join(homeDir, ".keys", KEY_PREFIX);
  fs.mkdirSync(keysDir, { recursive: true });

  // BitRouter format: 64-byte secret = 32-byte seed + 32-byte public key
  const secretKey = Buffer.concat([privateKey, publicKey]);

  const masterJson = {
    algorithm: "eddsa",
    secret_key: base64urlEncode(secretKey),
  };

  fs.writeFileSync(
    path.join(keysDir, "master.json"),
    JSON.stringify(masterJson, null, 2) + "\n",
    "utf-8"
  );

  // Write active prefix marker.
  fs.writeFileSync(
    path.join(homeDir, ".keys", "active"),
    KEY_PREFIX + "\n",
    "utf-8"
  );
}

/**
 * Load an existing Ed25519 keypair from the BitRouter key directory.
 *
 * Returns null if no keypair is found.
 */
export function loadKeypair(homeDir: string): Ed25519Keypair | null {
  try {
    // Read the active prefix.
    const activePath = path.join(homeDir, ".keys", "active");
    const prefix = fs.readFileSync(activePath, "utf-8").trim();

    // Read master.json.
    const masterPath = path.join(homeDir, ".keys", prefix, "master.json");
    const masterJson = JSON.parse(fs.readFileSync(masterPath, "utf-8")) as {
      algorithm: string;
      secret_key: string;
    };

    if (masterJson.algorithm !== "eddsa") return null;

    const secretKey = base64urlDecode(masterJson.secret_key);
    if (secretKey.length !== 64) return null;

    return {
      privateKey: Buffer.from(secretKey.subarray(0, 32)),
      publicKey: Buffer.from(secretKey.subarray(32, 64)),
    };
  } catch {
    return null;
  }
}

// ── JWT minting ───────────────────────────────────────────────────────

/**
 * Mint a JWT signed with EdDSA (Ed25519).
 *
 * Produces: base64url(header).base64url(claims).base64url(signature)
 * No padding, per BitRouter's token format.
 */
export function mintJwt(
  privateKey: Buffer,
  publicKey: Buffer,
  claims: Record<string, unknown>
): string {
  const header = { alg: "EdDSA", typ: "JWT" };

  const headerB64 = base64urlEncode(Buffer.from(JSON.stringify(header)));
  const claimsB64 = base64urlEncode(Buffer.from(JSON.stringify(claims)));
  const signingInput = `${headerB64}.${claimsB64}`;

  // Reconstruct the Node.js key object from raw bytes for signing.
  // Ed25519 PKCS8 DER: fixed prefix + 32-byte seed
  const pkcs8Prefix = Buffer.from(
    "302e020100300506032b657004220420",
    "hex"
  );
  const pkcs8Der = Buffer.concat([pkcs8Prefix, privateKey]);
  const keyObject = crypto.createPrivateKey({
    key: pkcs8Der,
    format: "der",
    type: "pkcs8",
  });

  const signature = crypto.sign(null, Buffer.from(signingInput), keyObject);

  return `${signingInput}.${base64urlEncode(signature)}`;
}

// ── Helpers ────────────────────────────────────────────────────────────

/**
 * Decode the `exp` claim from a JWT without verifying the signature.
 * Returns null if the token is malformed or has no exp claim.
 */
function decodeExp(jwt: string): number | null {
  try {
    const parts = jwt.split(".");
    if (parts.length !== 3) return null;
    const claims = JSON.parse(Buffer.from(parts[1], "base64url").toString()) as { exp?: number };
    return claims.exp ?? null;
  } catch {
    return null;
  }
}

// ── High-level API ────────────────────────────────────────────────────

/**
 * Ensure a keypair exists and return both API-scope and admin-scope JWTs.
 *
 * API token: no iat/exp, scope "api", cached at tokens/plugin.jwt.
 * Admin token: scope "admin", 24h expiry, cached at tokens/admin.jwt.
 *   Re-minted if the cached token expires within 1 hour.
 *
 * @returns Both JWT strings for authenticating with BitRouter.
 */
export function ensureAuth(homeDir: string): { apiToken: string; adminToken: string } {
  let keypair = loadKeypair(homeDir);

  if (!keypair) {
    keypair = generateKeypair();
    saveKeypair(homeDir, keypair.publicKey, keypair.privateKey);
  }

  const activePath = path.join(homeDir, ".keys", "active");
  const activePrefix = fs.readFileSync(activePath, "utf-8").trim();
  const tokensDir = path.join(homeDir, ".keys", activePrefix, "tokens");

  // ── API token (stable, no expiry) ──
  const apiTokenPath = path.join(tokensDir, "plugin.jwt");
  let apiToken: string | undefined;

  try {
    const cached = fs.readFileSync(apiTokenPath, "utf-8").trim();
    if (cached) apiToken = cached;
  } catch {
    // No cached token — mint below.
  }

  if (!apiToken) {
    apiToken = mintJwt(keypair.privateKey, keypair.publicKey, {
      iss: base64urlEncode(keypair.publicKey),
      scope: "api",
    });
    fs.mkdirSync(path.dirname(apiTokenPath), { recursive: true });
    fs.writeFileSync(apiTokenPath, apiToken + "\n", "utf-8");
  }

  // ── Admin token (24h expiry, refresh when within 1h of expiry) ──
  const adminTokenPath = path.join(tokensDir, "admin.jwt");
  let adminToken: string | undefined;

  try {
    const cached = fs.readFileSync(adminTokenPath, "utf-8").trim();
    if (cached) {
      const exp = decodeExp(cached);
      const now = Math.floor(Date.now() / 1000);
      if (exp && exp - now > 3600) {
        adminToken = cached;
      }
      // else: expired or about to expire — re-mint below.
    }
  } catch {
    // No cached token — mint below.
  }

  if (!adminToken) {
    const now = Math.floor(Date.now() / 1000);
    adminToken = mintJwt(keypair.privateKey, keypair.publicKey, {
      iss: base64urlEncode(keypair.publicKey),
      scope: "admin",
      iat: now,
      exp: now + 86400,
    });
    fs.mkdirSync(path.dirname(adminTokenPath), { recursive: true });
    fs.writeFileSync(adminTokenPath, adminToken + "\n", "utf-8");
  }

  return { apiToken, adminToken };
}
