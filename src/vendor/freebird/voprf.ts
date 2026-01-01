import { p256 } from '@noble/curves/p256';
import { sha256 } from '@noble/hashes/sha256';
import { concatBytes, bytesToHex, hexToBytes } from '@noble/hashes/utils';
import * as P256 from './p256.js';

/**
 * Represents a partial evaluation from a single server in MPC threshold issuance
 */
export interface PartialEvaluation {
  index: number;        // Server's key share index (1-based)
  value: Uint8Array;    // Encoded evaluated point (B_i)
}

// Constants from Rust implementation
const DLEQ_DST_PREFIX = new TextEncoder().encode('DLEQ-P256-v1');
const COMPRESSED_POINT_LEN = 33;
const PROOF_LEN = 64; // 32 bytes (c) + 32 bytes (s)
const TOKEN_LEN = COMPRESSED_POINT_LEN * 2 + PROOF_LEN;

/**
 * Internal state maintained between blinding and unblinding.
 */
export interface BlindState {
  r: bigint;  // Random scalar used for blinding
  p: any;     // Original hashed point H(input)
}

/**
 * Blinds the input for the VOPRF protocol.
 * Corresponds to Rust: Client::blind
 */
export function blind(
  input: Uint8Array,
  context: Uint8Array
): { blinded: Uint8Array; state: BlindState } {
  // 1. Map input to curve point P = H(input)
  const P = P256.hashToCurve(input, context);

  // 2. Generate random scalar r
  const r = P256.randomScalar();

  // 3. Compute blinded element A = P * r
  const A = P256.multiply(P, r);

  // 4. Return encoded A and state to recover randomness later
  return {
    blinded: P256.encodePoint(A),
    state: { r, p: P }, // We keep P to avoid re-hashing later
  };
}

/**
 * Verifies the issuer's response and returns the token.
 * Corresponds to Rust: Client::finalize
 *
 * Note: In Freebird v0.1.0, the "token" is the (A, B, Proof) tuple itself,
 * not the unblinded value. This enables stateless verification.
 */
export function finalize(
  state: BlindState,
  tokenB64: string,
  issuerPubkeyB64: string,
  context: Uint8Array
): Uint8Array {
  // 1. Decode inputs
  const tokenBytes = base64UrlToBytes(tokenB64);
  const pubkeyBytes = base64UrlToBytes(issuerPubkeyB64);

  if (tokenBytes.length !== TOKEN_LEN) {
    throw new Error(`Invalid token length: expected ${TOKEN_LEN}, got ${tokenBytes.length}`);
  }

  // 2. Parse Token Structure: [ A (33) | B (33) | Proof (64) ]
  const A_bytes = tokenBytes.slice(0, COMPRESSED_POINT_LEN);
  const B_bytes = tokenBytes.slice(COMPRESSED_POINT_LEN, COMPRESSED_POINT_LEN * 2);
  const proofBytes = tokenBytes.slice(COMPRESSED_POINT_LEN * 2);

  // 3. Decode Points
  const A = P256.decodePoint(A_bytes);
  const B = P256.decodePoint(B_bytes);
  const Q = P256.decodePoint(pubkeyBytes); // Issuer Public Key (Y in DLEQ terms)
  const G = p256.ProjectivePoint.BASE;

  // 4. Verify DLEQ Proof
  // Proves that log_G(Q) == log_A(B) (i.e., Issuer used the same private key)
  const isValid = verifyDleq(G, Q, A, B, proofBytes, context);

  if (!isValid) {
    throw new Error('VOPRF verification failed: Invalid DLEQ proof from issuer');
  }

  // 5. Return the verified token bytes
  return tokenBytes;
}

/**
 * Aggregates partial evaluations from multiple servers using Lagrange interpolation.
 * Used in MPC threshold issuance to reconstruct the final evaluated point.
 *
 * Math:
 * - Each server i has a key share k_i and returns B_i = A * k_i
 * - We reconstruct T = A * k where k = Σ(λ_i * k_i)
 * - Since scalar multiplication is linear: T = Σ(λ_i * B_i)
 * - Lagrange coefficient: λ_i = ∏(j≠i) (x_j / (x_j - x_i)) mod N
 *
 * @param partials - Array of partial evaluations with server indices
 * @returns Aggregated evaluated point (encoded)
 */
export function aggregate(partials: PartialEvaluation[]): Uint8Array {
  if (partials.length === 0) {
    throw new Error('Cannot aggregate zero partial evaluations');
  }

  // Special case: single server (non-MPC mode)
  if (partials.length === 1) {
    return partials[0].value;
  }

  // Decode all partial points
  const points = partials.map(p => ({
    index: p.index,
    point: P256.decodePoint(p.value)
  }));

  // Extract indices for Lagrange computation
  const indices = points.map(p => BigInt(p.index));

  // Compute Lagrange coefficients for each index
  const coefficients = indices.map((xi, i) =>
    computeLagrangeCoefficient(xi, indices)
  );

  // Aggregate: T = Σ(λ_i * P_i)
  let result = p256.ProjectivePoint.ZERO;

  for (let i = 0; i < points.length; i++) {
    const weighted = P256.multiply(points[i].point, coefficients[i]);
    result = result.add(weighted);
  }

  // Return encoded aggregated point
  return P256.encodePoint(result);
}

/**
 * Computes Lagrange interpolation coefficient for index x_i.
 *
 * Formula: λ_i = ∏(j≠i) (x_j / (x_j - x_i)) mod N
 *
 * We evaluate at x=0 for secret reconstruction:
 * λ_i = ∏(j≠i) (-x_j / (x_i - x_j)) mod N
 *     = ∏(j≠i) (x_j / (x_j - x_i)) mod N  (with sign handling)
 *
 * @param xi - The index for which to compute the coefficient
 * @param allIndices - All participating indices
 * @returns Lagrange coefficient λ_i mod N
 */
function computeLagrangeCoefficient(xi: bigint, allIndices: bigint[]): bigint {
  let numerator = 1n;
  let denominator = 1n;

  const N = P256.getCurveOrder();

  for (const xj of allIndices) {
    if (xj === xi) continue;

    // numerator *= xj
    numerator = P256.modMul(numerator, xj);

    // denominator *= (xj - xi)
    const diff = P256.modSub(xj, xi);
    denominator = P256.modMul(denominator, diff);
  }

  // λ_i = numerator / denominator mod N
  // Division in modular arithmetic: a/b = a * b^(-1) mod N
  const denomInverse = P256.invertScalar(denominator);
  return P256.modMul(numerator, denomInverse);
}

/**
 * Verifies a Chaum-Pedersen DLEQ proof (Fiat-Shamir transformed).
 * Matches Rust: crypto/src/voprf/dleq.rs
 *
 * Proves that log_G(Y) == log_A(B), i.e., the same scalar k was used
 * to compute Y = G * k and B = A * k.
 *
 * @param G - Generator point
 * @param Y - Public key (G * k)
 * @param A - Blinded input point
 * @param B - Evaluated point (A * k)
 * @param proofBytes - DLEQ proof (64 bytes: c || s)
 * @param context - Domain separation context
 * @returns true if proof is valid
 */
export function verifyDleq(
  G: any, // Generator
  Y: any, // Public Key
  A: any, // Blinded Point
  B: any, // Evaluated Point
  proofBytes: Uint8Array,
  context: Uint8Array
): boolean {
  // Decode proof scalars (c, s)
  const cBytes = proofBytes.slice(0, 32);
  const sBytes = proofBytes.slice(32, 64);
  const c = bytesToNumber(cBytes);
  const s = bytesToNumber(sBytes);

  // Recompute commitments
  // t1 = G * s - Y * c
  const sG = P256.multiply(G, s);
  const cY = P256.multiply(Y, c);
  const t1 = sG.subtract(cY);

  // t2 = A * s - B * c
  const sA = P256.multiply(A, s);
  const cB = P256.multiply(B, c);
  const t2 = sA.subtract(cB);

  // Recompute Challenge: H(dst_len || dst || G || Y || A || B || t1 || t2)
  const dst = concatBytes(DLEQ_DST_PREFIX, context);
  const dstLenBytes = numberToBytesBE(dst.length, 4); // u32 Big Endian

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

  // Check c == computedC
  return c === computedC;
}

// --- Helpers ---

function base64UrlToBytes(base64: string): Uint8Array {
  const binString = atob(base64.replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(binString, (m) => m.codePointAt(0)!);
}

export function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = '';
  const len = bytes.byteLength;
  for (let i = 0; i < len; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary)
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
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
  // Reduce modulo curve order (Rust: Scalar::reduce_bytes)
  return num % p256.CURVE.n;
}
