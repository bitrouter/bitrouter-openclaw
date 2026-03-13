/**
 * Ed25519 keypair generation and JWT minting for BitRouter auth.
 *
 * BitRouter v0.6.1 switched to a "web3" keypair format (Solana-compatible
 * Ed25519) and SOL_EDDSA JWT signing.
 *
 * Key format (bitrouter v0.6.1):
 *   master.json: { "algorithm": "web3", "seed": "<base64url(32-byte seed)>" }
 *   The 32-byte seed is used directly with Node.js Ed25519 (PKCS8 DER wrapping).
 *   The public key is base58-encoded to form the Solana address.
 *
 * JWT format (bitrouter v0.6.1):
 *   header: { alg: "SOL_EDDSA", typ: "JWT" }
 *   claims: { iss: "solana:<chain-id>:<base58-pubkey>", chain: "solana:<chain-id>", scope, ... }
 *   signature: Ed25519 over "base64url(header).base64url(claims)"
 *
 * Solana mainnet chain ID: 5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

// ── Constants ─────────────────────────────────────────────────────────

/** Solana mainnet genesis hash (chain identifier used in JWT iss). */
const SOLANA_CHAIN_ID = "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";

/** PKCS8 DER prefix for a bare Ed25519 private key seed (RFC 8410). */
const PKCS8_ED25519_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");

// ── Base64url helpers ─────────────────────────────────────────────────

function base64urlEncode(buf: Buffer): string {
  return buf.toString("base64url");
}

function base64urlDecode(str: string): Buffer {
  return Buffer.from(str, "base64url");
}

// ── Base58 encode (Solana address format) ─────────────────────────────

const BASE58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

function base58Encode(buf: Buffer): string {
  let n = BigInt("0x" + buf.toString("hex"));
  let out = "";
  while (n > 0n) {
    out = BASE58_ALPHABET[Number(n % 58n)] + out;
    n /= 58n;
  }
  for (const byte of buf) {
    if (byte === 0) out = "1" + out;
    else break;
  }
  return out;
}

// ── Keypair types ─────────────────────────────────────────────────────

export interface Ed25519Keypair {
  /** Raw 32-byte seed (used to derive the private key). */
  seed: Buffer;
  /** Raw 32-byte public key. */
  publicKey: Buffer;
  /** Solana base58-encoded public key address. */
  address: string;
}

// ── Keypair derivation ────────────────────────────────────────────────

/**
 * Derive the Ed25519 public key and Solana address from a 32-byte seed.
 *
 * Node.js crypto requires PKCS8 DER wrapping to create an Ed25519 key
 * from raw bytes. The resulting public key bytes are then base58-encoded
 * to produce the Solana address.
 */
function derivePublicKey(seed: Buffer): { publicKey: Buffer; address: string } {
  const pkcs8Der = Buffer.concat([PKCS8_ED25519_PREFIX, seed]);
  const privKey = crypto.createPrivateKey({ key: pkcs8Der, format: "der", type: "pkcs8" });
  const pubKeyObj = crypto.createPublicKey(privKey);
  const spki = pubKeyObj.export({ type: "spki", format: "der" }) as Buffer;
  const publicKey = Buffer.from(spki.subarray(spki.length - 32));
  return { publicKey, address: base58Encode(publicKey) };
}

/**
 * Generate a new Ed25519 keypair in BitRouter v0.6.1 web3 format.
 */
export function generateKeypair(): Ed25519Keypair {
  const seed = crypto.randomBytes(32);
  const { publicKey, address } = derivePublicKey(seed);
  return { seed, publicKey, address };
}

// ── Keypair persistence ───────────────────────────────────────────────

/** Key prefix used for BitRouter's key directory structure. */
const KEY_PREFIX = "openclaw";

/**
 * Save a keypair to BitRouter's v0.6.1 key directory format.
 *
 * Writes:
 *   <homeDir>/.keys/<prefix>/master.json — { algorithm: "web3", seed: "<base64url>" }
 *   <homeDir>/.keys/active              — the active key prefix
 */
export function saveKeypair(homeDir: string, keypair: Ed25519Keypair): void {
  const keysDir = path.join(homeDir, ".keys", KEY_PREFIX);
  fs.mkdirSync(keysDir, { recursive: true });

  const masterJson = {
    algorithm: "web3",
    seed: base64urlEncode(keypair.seed),
  };

  fs.writeFileSync(
    path.join(keysDir, "master.json"),
    JSON.stringify(masterJson, null, 2) + "\n",
    "utf-8"
  );

  fs.writeFileSync(
    path.join(homeDir, ".keys", "active"),
    KEY_PREFIX + "\n",
    "utf-8"
  );
}

/**
 * Load an existing keypair from BitRouter's key directory.
 *
 * Supports both v0.6.1 "web3" format and legacy v0.4.x "eddsa" format.
 * Returns null if no valid keypair is found.
 */
export function loadKeypair(homeDir: string): Ed25519Keypair | null {
  try {
    const activePath = path.join(homeDir, ".keys", "active");
    const prefix = fs.readFileSync(activePath, "utf-8").trim();

    const masterPath = path.join(homeDir, ".keys", prefix, "master.json");
    const masterJson = JSON.parse(fs.readFileSync(masterPath, "utf-8")) as {
      algorithm: string;
      seed?: string;
      secret_key?: string;
    };

    let seed: Buffer;

    if (masterJson.algorithm === "web3" && masterJson.seed) {
      // v0.6.1 format: 32-byte seed, base64url-encoded.
      seed = base64urlDecode(masterJson.seed);
      if (seed.length !== 32) return null;
    } else if (masterJson.algorithm === "eddsa" && masterJson.secret_key) {
      // Legacy v0.4.x format: 64-byte seed+pubkey, first 32 bytes = seed.
      const secretKey = base64urlDecode(masterJson.secret_key);
      if (secretKey.length !== 64) return null;
      seed = Buffer.from(secretKey.subarray(0, 32));
    } else {
      return null;
    }

    const { publicKey, address } = derivePublicKey(seed);
    return { seed, publicKey, address };
  } catch {
    return null;
  }
}

// ── JWT minting ───────────────────────────────────────────────────────

/**
 * Mint a SOL_EDDSA JWT for BitRouter v0.6.1.
 *
 * Header: { alg: "SOL_EDDSA", typ: "JWT" }
 * Claims: { iss: "solana:<chain>:<address>", chain: "solana:<chain>", ...extra }
 */
export function mintJwt(
  keypair: Ed25519Keypair,
  claims: Record<string, unknown>
): string {
  const header = { alg: "SOL_EDDSA", typ: "JWT" };

  const fullClaims = {
    iss: `solana:${SOLANA_CHAIN_ID}:${keypair.address}`,
    chain: `solana:${SOLANA_CHAIN_ID}`,
    ...claims,
  };

  const headerB64 = base64urlEncode(Buffer.from(JSON.stringify(header)));
  const claimsB64 = base64urlEncode(Buffer.from(JSON.stringify(fullClaims)));
  const signingInput = `${headerB64}.${claimsB64}`;

  const pkcs8Der = Buffer.concat([PKCS8_ED25519_PREFIX, keypair.seed]);
  const keyObject = crypto.createPrivateKey({ key: pkcs8Der, format: "der", type: "pkcs8" });
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
 * Ensure a keypair exists in the homeDir and return both API-scope
 * and admin-scope JWTs signed with SOL_EDDSA (BitRouter v0.6.1).
 *
 * If a v0.6.1-format keypair ("web3") already exists it is reused.
 * If only a legacy v0.4.x keypair ("eddsa") is found, a new v0.6.1
 * keypair is generated and saved (the legacy one is left in place).
 *
 * API token:   scope "api",   no expiry, cached at tokens/plugin.jwt.
 * Admin token: scope "admin", 24h expiry, cached at tokens/admin.jwt,
 *              re-minted when within 1h of expiry.
 */
export function ensureAuth(homeDir: string): { apiToken: string; adminToken: string } {
  let keypair = loadKeypair(homeDir);

  // Regenerate if missing or if we loaded a legacy keypair (algorithm mismatch).
  const masterPath = (() => {
    try {
      const prefix = fs.readFileSync(path.join(homeDir, ".keys", "active"), "utf-8").trim();
      return path.join(homeDir, ".keys", prefix, "master.json");
    } catch {
      return null;
    }
  })();

  const isLegacy = (() => {
    if (!masterPath) return false;
    try {
      const m = JSON.parse(fs.readFileSync(masterPath, "utf-8")) as { algorithm?: string };
      return m.algorithm !== "web3";
    } catch {
      return false;
    }
  })();

  if (!keypair || isLegacy) {
    keypair = generateKeypair();
    saveKeypair(homeDir, keypair);
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
    apiToken = mintJwt(keypair, { scope: "api" });
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
    }
  } catch {
    // No cached token — mint below.
  }

  if (!adminToken) {
    const now = Math.floor(Date.now() / 1000);
    adminToken = mintJwt(keypair, {
      scope: "admin",
      iat: now,
      exp: now + 86400,
    });
    fs.mkdirSync(path.dirname(adminTokenPath), { recursive: true });
    fs.writeFileSync(adminTokenPath, adminToken + "\n", "utf-8");
  }

  return { apiToken, adminToken };
}
