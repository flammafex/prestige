/**
 * Gate Status UI Component
 * Shows user's eligibility status for voting and ballot creation
 */

const gates = {
  info: null,
  userStatus: null,

  /**
   * Load gate info and check user eligibility
   */
  async load() {
    const userIdentity = await window.identity.getIdentity();

    // Get gate configuration
    this.info = await api.request('GET', '/api/gates');

    // Check user's eligibility
    const [ballotCheck, voterCheck] = await Promise.all([
      api.request('POST', '/api/gates/ballot/check', { publicKey: userIdentity.publicKey }),
      api.request('POST', '/api/gates/voter/check', { publicKey: userIdentity.publicKey }),
    ]);

    this.userStatus = {
      canCreateBallot: ballotCheck.allowed,
      ballotReason: ballotCheck.reason,
      ballotProgress: ballotCheck.progress,
      canVote: voterCheck.allowed,
      voterReason: voterCheck.reason,
    };

    return this.userStatus;
  },

  /**
   * Render gate status banner (for top of pages)
   */
  renderBanner(containerId) {
    const container = document.getElementById(containerId);
    if (!container || !this.userStatus) return;

    const { canVote, voterReason } = this.userStatus;

    let html = '';

    if (!canVote) {
      html += `
        <div class="alert alert-warning">
          <strong>Voting restricted:</strong> ${voterReason || 'You are not eligible to vote on this instance.'}
          <div class="hint">${this.info?.voter?.description || ''}</div>
        </div>
      `;
    }

    container.innerHTML = html;
  },

  /**
   * Render full gate info (for settings/info page)
   */
  renderInfo(containerId) {
    const container = document.getElementById(containerId);
    if (!container || !this.info) return;

    container.innerHTML = `
      <div class="gate-info">
        <div class="gate-section">
          <h4>Ballot Creation</h4>
          <p class="gate-type">${this.info.ballot.description}</p>
          <ul class="gate-requirements">
            ${this.info.ballot.requirements.map(r => `<li>${escapeHtml(r)}</li>`).join('')}
          </ul>
          <div class="gate-status ${this.userStatus?.canCreateBallot ? 'status-allowed' : 'status-denied'}">
            ${this.userStatus?.canCreateBallot ? 'You can create ballots' : (this.userStatus?.ballotReason || 'Cannot create ballots')}
          </div>
        </div>

        <div class="gate-section">
          <h4>Voting</h4>
          <p class="gate-type">${this.info.voter.description}</p>
          <ul class="gate-requirements">
            ${this.info.voter.requirements.map(r => `<li>${escapeHtml(r)}</li>`).join('')}
          </ul>
          <div class="gate-status ${this.userStatus?.canVote ? 'status-allowed' : 'status-denied'}">
            ${this.userStatus?.canVote ? 'You can vote' : (this.userStatus?.voterReason || 'Cannot vote')}
          </div>
        </div>
      </div>
    `;
  },

  /**
   * Check if user can create ballots (call after load())
   */
  canCreate() {
    return this.userStatus?.canCreateBallot ?? false;
  },

  /**
   * Check if user can vote (call after load())
   */
  canVote() {
    return this.userStatus?.canVote ?? false;
  },

  /**
   * Get ballot creation reason (why denied)
   */
  getBallotReason() {
    return this.userStatus?.ballotReason || 'You are not authorized to create ballots.';
  },

  /**
   * Get voter reason (why denied)
   */
  getVoterReason() {
    return this.userStatus?.voterReason || 'You are not eligible to vote.';
  }
};

/**
 * Escape HTML to prevent XSS
 */
function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

// Export for use in other scripts
if (typeof window !== 'undefined') {
  window.gates = gates;
}
