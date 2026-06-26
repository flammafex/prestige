/**
 * Prestige API Client
 * HTTP client for ballot creation, voting, and results
 */

const api = {
  baseUrl: '',

  async request(method, path, body = null, extraHeaders = {}) {
    const options = {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...extraHeaders,
      },
    };

    if (body) {
      options.body = JSON.stringify(body);
    }

    const response = await fetch(`${this.baseUrl}${path}`, options);
    const data = await response.json();

    if (!response.ok) {
      const error = new Error(data.error || 'Request failed');
      error.code = data.code;
      error.status = response.status;
      throw error;
    }

    return data;
  },

  // ============= Ballot Operations =============

  /**
   * Build the exact ballot creation request body object.
   * Centralized so signing and fetch serialization cannot drift — the caller
   * signs createBallotBodyString(params) and this method sends the same object.
   */
  buildCreateBallotBody({
    question,
    choices,
    durationMinutes,
    revealWindowMinutes,
    eligibility,
    voteType,
    creationToken,
  }) {
    return {
      question,
      choices,
      durationMinutes,
      revealWindowMinutes,
      eligibility,
      voteType,
      creationToken,
    };
  },

  /**
   * Return the exact JSON string that createBallot will send for these params.
   * The caller signs this string with identity.signMessage and passes the
   * resulting signature as creatorSignature. This guarantees the signature
   * covers the exact body fetch sends, including field order.
   */
  createBallotBodyString(params) {
    return JSON.stringify(this.buildCreateBallotBody(params));
  },

  async createBallot({ creatorPublicKey, creatorSignature, ...ballotParams } = {}) {
    const body = this.buildCreateBallotBody(ballotParams);
    const headers = {};
    if (creatorPublicKey) headers['X-Public-Key'] = creatorPublicKey;
    if (creatorSignature) headers['X-Signature'] = creatorSignature;

    return this.request('POST', '/api/ballot', body, headers);
  },

  async getBallot(id) {
    return this.request('GET', `/api/ballot/${id}`);
  },

  async getBallotStatus(id) {
    return this.request('GET', `/api/ballot/${id}/status`);
  },

  async listBallots({ status, limit } = {}) {
    let path = '/api/ballots';
    const params = new URLSearchParams();
    if (status) params.set('status', status);
    if (limit) params.set('limit', limit.toString());
    if (params.toString()) path += '?' + params.toString();
    return this.request('GET', path);
  },

  // ============= Vote Operations =============

  async castVote({ ballotId, commitment, nullifier, proof }) {
    return this.request('POST', '/api/vote', {
      ballotId,
      commitment,
      nullifier,
      proof,
    });
  },

  async getVotes(ballotId) {
    return this.request('GET', `/api/votes/${ballotId}`);
  },

  async requestTokenChallenge(ballotId, publicKey) {
    return this.request('POST', `/api/token/${ballotId}/challenge`, { publicKey });
  },

  async requestToken(ballotId, auth) {
    return this.request('POST', `/api/token/${ballotId}`, auth || {});
  },

  // ============= Reveal Operations =============

  async submitReveal({ ballotId, nullifier, choice, salt, voteData }) {
    return this.request('POST', '/api/reveal', {
      ballotId,
      nullifier,
      choice,
      salt,
      voteData,
    });
  },

  async getReveals(ballotId) {
    return this.request('GET', `/api/reveals/${ballotId}`);
  },

  async getRevealStats(ballotId) {
    return this.request('GET', `/api/reveals/${ballotId}/stats`);
  },

  // ============= Results Operations =============

  async getResults(ballotId) {
    return this.request('GET', `/api/results/${ballotId}`);
  },

  async getLiveTally(ballotId) {
    return this.request('GET', `/api/results/${ballotId}/live`);
  },

  async getVerificationReport(ballotId) {
    return this.request('GET', `/api/results/${ballotId}/verify`);
  },

  // ============= Audit Export Operations =============

  getExportJsonUrl(ballotId) {
    return `${this.baseUrl}/api/results/${ballotId}/export/json`;
  },

  getExportCsvUrl(ballotId) {
    return `${this.baseUrl}/api/results/${ballotId}/export/csv`;
  },

  // ============= Crypto Helpers (for development) =============

  async generateSalt() {
    const response = await this.request('GET', '/api/crypto/salt');
    return response.salt;
  },

  async generateSecret() {
    const response = await this.request('GET', '/api/crypto/secret');
    return response.secret;
  },

  // NOTE: /api/crypto/commitment and /api/crypto/nullifier endpoints were
  // removed (they accepted voterSecret/choice over HTTP, breaking anonymity).
  // Use window.prestigeCrypto for client-side commitment/nullifier generation.

  // ============= Health =============

  async healthCheck() {
    return this.request('GET', '/health');
  },

  async getInfo() {
    return this.request('GET', '/api/info');
  },
};

// Export for use in other scripts
if (typeof window !== 'undefined') {
  window.api = api;
}
