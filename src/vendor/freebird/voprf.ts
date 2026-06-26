import { p256 } from '@noble/curves/p256';
import { sha256 } from '@noble/hashes/sha256';
import { concatBytes, bytesToHex, hexToBytes } from '@noble/hashes/utils';
import * as P256 from './p256.js';

const DLEQ_DST_PREFIX = new TextEncoder().encode('DLEQ-P256-v1');
const COMPRESSED_POINT_LEN = 33;
const TOKEN_VERSION_V1 = 0x01;
const TOKEN_VERSION_LEN = 1;
const PROOF_LEN = 64;
const RAW_TOKEN_LEN_V1 = TOKEN_VERSION_LEN + COMPRESSED_POINT_LEN * 2 + PROOF_LEN;
const REDEMPTION_TOKEN_VERSION_V4 = 0x04;
const PRIVATE_TOKEN_LEN = 32;

export interface BlindState {
  r: bigint;
  p: any;
}

export function blind(
  input: Uint8Array,
  context: Uint8Array
): { blinded: Uint8Array; state: BlindState } {
  const P = P256.hashToCurve(input, context);
  const r = P256.randomScalar();
  const A = P256.multiply(P, r);

  return {
    blinded: P256.encodePoint(A),
    state: { r, p: P },
  };
}

export function finalize(
  state: BlindState,
  tokenB64: string,
  issuerPubkeyB64: string,
  context: Uint8Array
): Uint8Array {
  const tokenBytes = base64UrlToBytes(tokenB64);
  const pubkeyBytes = base64UrlToBytes(issuerPubkeyB64);

  if (tokenBytes.length !== RAW_TOKEN_LEN_V1) {
    throw new Error(
      `Invalid token length: expected ${RAW_TOKEN_LEN_V1}; got ${tokenBytes.length}`
    );
  }

  if (tokenBytes[0] !== TOKEN_VERSION_V1) {
    throw new Error(`Unsupported token version: ${tokenBytes[0]}`);
  }

  const offset = TOKEN_VERSION_LEN;
  const A_bytes = tokenBytes.slice(offset, offset + COMPRESSED_POINT_LEN);
  const B_bytes = tokenBytes.slice(
    offset + COMPRESSED_POINT_LEN,
    offset + COMPRESSED_POINT_LEN * 2
  );
  const proofBytes = tokenBytes.slice(offset + COMPRESSED_POINT_LEN * 2);

  const A = P256.decodePoint(A_bytes);
  const B = P256.decodePoint(B_bytes);
  const Q = P256.decodePoint(pubkeyBytes);
  const G = p256.ProjectivePoint.BASE;

  if (!verifyDleq(G, Q, A, B, proofBytes, context)) {
    throw new Error('VOPRF verification failed: Invalid DLEQ proof from issuer');
  }

  const rInv = P256.invertScalar(state.r);
  const W = P256.multiply(B, rInv);
  const wBytes = P256.encodePoint(W);
  const finalizeInput = concatBytes(
    new TextEncoder().encode('VOPRF-P256-SHA256:Finalize'),
    context,
    wBytes
  );

  return sha256(finalizeInput);
}

export function buildScopeDigest(verifierId: string, audience: string): Uint8Array {
  const verifierIdBytes = new TextEncoder().encode(verifierId);
  const audienceBytes = new TextEncoder().encode(audience);
  if (verifierIdBytes.length === 0 || verifierIdBytes.length > 255) {
    throw new Error('verifier_id must be 1-255 bytes');
  }
  if (audienceBytes.length === 0 || audienceBytes.length > 255) {
    throw new Error('audience must be 1-255 bytes');
  }

  return sha256(concatBytes(
    new TextEncoder().encode('freebird:scope:v4'),
    new Uint8Array([verifierIdBytes.length]),
    verifierIdBytes,
    new Uint8Array([audienceBytes.length]),
    audienceBytes
  ));
}

export function buildPrivateTokenInput(
  issuerId: string,
  kid: string,
  nonce: Uint8Array,
  scopeDigest: Uint8Array
): Uint8Array {
  const issuerIdBytes = new TextEncoder().encode(issuerId);
  const kidBytes = new TextEncoder().encode(kid);
  if (issuerIdBytes.length === 0 || issuerIdBytes.length > 255) {
    throw new Error('issuer_id must be 1-255 bytes');
  }
  if (kidBytes.length === 0 || kidBytes.length > 255) {
    throw new Error('kid must be 1-255 bytes');
  }
  if (nonce.length !== PRIVATE_TOKEN_LEN) throw new Error('nonce must be 32 bytes');
  if (scopeDigest.length !== PRIVATE_TOKEN_LEN) throw new Error('scope_digest must be 32 bytes');

  return concatBytes(
    new TextEncoder().encode('freebird:private-token-input:v4'),
    new Uint8Array([issuerIdBytes.length]),
    issuerIdBytes,
    new Uint8Array([kidBytes.length]),
    kidBytes,
    nonce,
    scopeDigest
  );
}

export function buildRedemptionToken(
  nonce: Uint8Array,
  scopeDigest: Uint8Array,
  kid: string,
  issuerId: string,
  authenticator: Uint8Array
): Uint8Array {
  const kidBytes = new TextEncoder().encode(kid);
  const issuerIdBytes = new TextEncoder().encode(issuerId);
  if (kidBytes.length === 0 || kidBytes.length > 255) throw new Error('kid must be 1-255 bytes');
  if (issuerIdBytes.length === 0 || issuerIdBytes.length > 255) throw new Error('issuer_id must be 1-255 bytes');
  if (nonce.length !== PRIVATE_TOKEN_LEN) throw new Error('nonce must be 32 bytes');
  if (scopeDigest.length !== PRIVATE_TOKEN_LEN) throw new Error('scope_digest must be 32 bytes');
  if (authenticator.length !== PRIVATE_TOKEN_LEN) throw new Error('authenticator must be 32 bytes');

  const buf = new Uint8Array(1 + 32 + 32 + 1 + kidBytes.length + 1 + issuerIdBytes.length + 32);
  let pos = 0;
  buf[pos++] = REDEMPTION_TOKEN_VERSION_V4;
  buf.set(nonce, pos); pos += 32;
  buf.set(scopeDigest, pos); pos += 32;
  buf[pos++] = kidBytes.length;
  buf.set(kidBytes, pos); pos += kidBytes.length;
  buf[pos++] = issuerIdBytes.length;
  buf.set(issuerIdBytes, pos); pos += issuerIdBytes.length;
  buf.set(authenticator, pos);
  return buf;
}

export function parseRedemptionToken(bytes: Uint8Array): {
  nonce: Uint8Array;
  scopeDigest: Uint8Array;
  kid: string;
  issuerId: string;
  authenticator: Uint8Array;
} {
  if (bytes.length < 101 || bytes.length > 512) throw new Error('invalid token length');
  if (bytes[0] !== REDEMPTION_TOKEN_VERSION_V4) throw new Error('unsupported token version');
  let pos = 1;
  const nonce = bytes.slice(pos, pos + 32); pos += 32;
  const scopeDigest = bytes.slice(pos, pos + 32); pos += 32;
  const kidLen = bytes[pos++];
  if (kidLen === 0 || pos + kidLen > bytes.length) throw new Error('invalid kid_len');
  const kid = new TextDecoder().decode(bytes.slice(pos, pos + kidLen)); pos += kidLen;
  const issuerIdLen = bytes[pos++];
  if (issuerIdLen === 0 || pos + issuerIdLen > bytes.length) throw new Error('invalid issuer_id_len');
  const issuerId = new TextDecoder().decode(bytes.slice(pos, pos + issuerIdLen)); pos += issuerIdLen;
  if (bytes.length - pos !== 32) throw new Error('invalid authenticator length');
  const authenticator = bytes.slice(pos, pos + 32);
  return { nonce, scopeDigest, kid, issuerId, authenticator };
}

export function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary)
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

export function base64UrlToBytes(base64: string): Uint8Array {
  const normalized = base64.replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized.padEnd(
    normalized.length + ((4 - normalized.length % 4) % 4),
    '='
  );
  const binString = atob(padded);
  return Uint8Array.from(binString, (m) => m.codePointAt(0)!);
}

function verifyDleq(
  G: any,
  Y: any,
  A: any,
  B: any,
  proofBytes: Uint8Array,
  context: Uint8Array
): boolean {
  const cBytes = proofBytes.slice(0, 32);
  const sBytes = proofBytes.slice(32, 64);
  const c = bytesToNumber(cBytes);
  const s = bytesToNumber(sBytes);

  const sG = P256.multiply(G, s);
  const cY = P256.multiply(Y, c);
  const t1 = sG.subtract(cY);

  const sA = P256.multiply(A, s);
  const cB = P256.multiply(B, c);
  const t2 = sA.subtract(cB);

  const dst = concatBytes(DLEQ_DST_PREFIX, context);
  const dstLenBytes = numberToBytesBE(dst.length, 4);

  const transcript = concatBytes(
    dstLenBytes,
    dst,
    P256.encodePoint(G),
    P256.encodePoint(Y),
    P256.encodePoint(A),
    P256.encodePoint(B),
    P256.encodePoint(t1),
    P256.encodePoint(t2)
  );

  const computedC = hashToScalar(transcript);

  return c === computedC;
}

function bytesToNumber(bytes: Uint8Array): bigint {
  return BigInt('0x' + bytesToHex(bytes));
}

function numberToBytesBE(num: number, len: number): Uint8Array {
  const hex = num.toString(16).padStart(len * 2, '0');
  return hexToBytes(hex);
}

function hashToScalar(bytes: Uint8Array): bigint {
  const hash = sha256(bytes);
  const num = bytesToNumber(hash);
  return num % p256.CURVE.n;
}
