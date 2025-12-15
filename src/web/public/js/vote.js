/**
 * Voting logic for Prestige
 * Handles the commit-reveal voting flow
 */

// Get ballot ID from URL
const pathParts = window.location.pathname.split('/');
const ballotId = pathParts[pathParts.length - 1];

let ballot = null;
let selectedChoice = null;
let timerInterval = null;

/**
 * Initialize the voting page
 */
async function initVotePage() {
  await identity.initIdentity();
  await loadBallot();
}

/**
 * Load ballot data and update UI
 */
async function loadBallot() {
  const loadingCard = document.getElementById('loading-card');
  const errorCard = document.getElementById('error-card');
  const ballotCard = document.getElementById('ballot-card');
  const statsCard = document.getElementById('stats-card');

  try {
    // Get ballot status
    const status = await api.getBallotStatus(ballotId);
    ballot = status.ballot;

    // Hide loading
    loadingCard.classList.add('hidden');

    // Show ballot info
    document.getElementById('ballot-question').textContent = ballot.question;

    const statusBadge = document.getElementById('ballot-status');
    statusBadge.textContent = status.status;
    statusBadge.className = 'badge badge-' + status.status;

    // Check local vote data
    const hasVotedLocal = await identity.hasVotedLocally(ballotId);
    const voteData = await identity.getVoteData(ballotId);

    // Update stats
    document.getElementById('stat-votes').textContent = status.voteCount;

    // Start timer
    updateTimer(status);
    timerInterval = setInterval(() => updateTimer(status), 1000);

    // Show appropriate section based on status
    if (status.status === 'petition') {
      // Ballot is waiting for signatures
      await loadPetitionStatus(status);
    } else if (status.status === 'voting') {
      if (hasVotedLocal) {
        showVotedSection(voteData);
      } else {
        showVotingSection();
      }
    } else if (status.status === 'revealing') {
      await showRevealSection(hasVotedLocal, voteData);
    } else {
      // Finalized - show results link
      showResultsLink();
    }

    // Show cards
    ballotCard.classList.remove('hidden');
    statsCard.classList.remove('hidden');

    // Get reveal stats
    try {
      const revealStats = await api.getRevealStats(ballotId);
      document.getElementById('stat-reveals').textContent = revealStats.totalReveals;
    } catch (e) {
      // Ignore if not available yet
    }

  } catch (error) {
    loadingCard.classList.add('hidden');
    errorCard.classList.remove('hidden');
    document.getElementById('error-message').textContent = error.message;
  }
}

/**
 * Show voting section with choices
 */
function showVotingSection() {
  const section = document.getElementById('voting-section');
  const choicesList = document.getElementById('choices-list');

  // Render choices
  choicesList.innerHTML = ballot.choices.map((choice, index) => `
    <li class="choice-item" data-choice="${escapeHtml(choice)}" onclick="selectChoice(this)">
      <input type="radio" name="choice" id="choice-${index}" value="${escapeHtml(choice)}">
      <label for="choice-${index}" class="choice-text">${escapeHtml(choice)}</label>
    </li>
  `).join('');

  section.classList.remove('hidden');

  // Set up form handler
  document.getElementById('vote-form').addEventListener('submit', handleVoteSubmit);
}

/**
 * Handle choice selection
 */
function selectChoice(element) {
  // Remove selection from all
  document.querySelectorAll('.choice-item').forEach(el => {
    el.classList.remove('selected');
    el.querySelector('input').checked = false;
  });

  // Select this one
  element.classList.add('selected');
  element.querySelector('input').checked = true;
  selectedChoice = element.dataset.choice;

  // Enable vote button
  document.getElementById('vote-btn').disabled = false;
}

/**
 * Handle vote submission
 */
async function handleVoteSubmit(e) {
  e.preventDefault();

  if (!selectedChoice) {
    alert('Please select a choice');
    return;
  }

  const btn = document.getElementById('vote-btn');
  btn.disabled = true;
  btn.textContent = 'Casting vote...';

  try {
    // Get voter secret
    const voterSecret = await identity.getVoterSecret(ballotId);

    // Generate salt and commitment
    const salt = prestigeCrypto.generateSalt();
    const commitment = await prestigeCrypto.generateCommitment(selectedChoice, salt);
    const nullifier = await prestigeCrypto.generateNullifier(voterSecret, ballotId);

    // Get eligibility token
    const proof = await api.requestToken(ballotId);

    // Cast vote
    await api.castVote({
      ballotId,
      commitment,
      nullifier,
      proof,
    });

    // Save vote data locally for reveal phase
    await identity.saveVoteData(ballotId, {
      choice: selectedChoice,
      salt,
      nullifier,
      commitment,
    });

    // Show voted section
    const voteData = await identity.getVoteData(ballotId);
    document.getElementById('voting-section').classList.add('hidden');
    showVotedSection(voteData);

    // Update vote count
    const status = await api.getBallotStatus(ballotId);
    document.getElementById('stat-votes').textContent = status.voteCount;

  } catch (error) {
    alert('Error casting vote: ' + error.message);
    btn.disabled = false;
    btn.textContent = 'Cast Vote';
  }
}

/**
 * Show voted confirmation section
 */
function showVotedSection(voteData) {
  const section = document.getElementById('voted-section');
  section.classList.remove('hidden');

  // Show pending reveal notice
  if (voteData && !voteData.revealed) {
    document.getElementById('pending-reveal').classList.remove('hidden');
  }
}

/**
 * Show reveal section
 */
async function showRevealSection(hasVotedLocal, voteData) {
  const section = document.getElementById('reveal-section');
  section.classList.remove('hidden');

  if (!hasVotedLocal) {
    // Didn't vote
    document.getElementById('no-vote-to-reveal').classList.remove('hidden');
    return;
  }

  if (voteData.revealed) {
    // Already revealed
    document.getElementById('already-revealed').classList.remove('hidden');
    return;
  }

  // Show reveal button
  const formContainer = document.getElementById('reveal-form-container');
  formContainer.classList.remove('hidden');

  document.getElementById('reveal-btn').addEventListener('click', handleRevealSubmit);
}

/**
 * Handle reveal submission
 */
async function handleRevealSubmit() {
  const btn = document.getElementById('reveal-btn');
  btn.disabled = true;
  btn.textContent = 'Revealing...';

  try {
    const voteData = await identity.getVoteData(ballotId);

    if (!voteData) {
      throw new Error('No vote data found locally');
    }

    // Submit reveal
    await api.submitReveal({
      ballotId,
      nullifier: voteData.nullifier,
      choice: voteData.choice,
      salt: voteData.salt,
    });

    // Mark as revealed
    await identity.markRevealed(ballotId);

    // Update UI
    document.getElementById('reveal-form-container').classList.add('hidden');
    document.getElementById('already-revealed').classList.remove('hidden');

    // Update reveal count
    const revealStats = await api.getRevealStats(ballotId);
    document.getElementById('stat-reveals').textContent = revealStats.totalReveals;

  } catch (error) {
    alert('Error revealing vote: ' + error.message);
    btn.disabled = false;
    btn.textContent = 'Reveal My Vote';
  }
}

/**
 * Show results link
 */
function showResultsLink() {
  const link = document.getElementById('results-link');
  link.classList.remove('hidden');
  document.getElementById('view-results-btn').href = `/r/${ballotId}`;
}

/**
 * Update timer display
 */
function updateTimer(status) {
  const timerEl = document.getElementById('ballot-timer');
  const statTime = document.getElementById('stat-time');
  const statLabel = document.getElementById('stat-time-label');

  const now = Date.now();
  let remaining;
  let label;

  if (status.status === 'petition') {
    remaining = 0;
    label = 'Awaiting signatures';
  } else if (status.status === 'voting') {
    remaining = status.timeRemaining - (Date.now() - status.ballot.created);
    remaining = Math.max(0, ballot.deadline - now);
    label = 'Until voting ends';
  } else if (status.status === 'revealing') {
    remaining = Math.max(0, ballot.revealDeadline - now);
    label = 'Until reveal ends';
  } else {
    remaining = 0;
    label = 'Finalized';
  }

  const formatted = formatDuration(remaining);
  timerEl.innerHTML = `<span class="timer-value">${formatted}</span> ${label}`;
  statTime.textContent = formatted;
  statLabel.textContent = label;

  // Check if phase changed
  if (remaining <= 0 && status.status !== 'finalized') {
    clearInterval(timerInterval);
    setTimeout(() => location.reload(), 2000);
  }
}

/**
 * Format duration as HH:MM:SS or DD:HH:MM
 */
function formatDuration(ms) {
  if (ms <= 0) return '00:00:00';

  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (days > 0) {
    return `${days}d ${hours % 24}h ${minutes % 60}m`;
  }

  return [
    hours.toString().padStart(2, '0'),
    (minutes % 60).toString().padStart(2, '0'),
    (seconds % 60).toString().padStart(2, '0'),
  ].join(':');
}

/**
 * Escape HTML to prevent XSS
 */
function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

/**
 * Load and display petition status
 */
async function loadPetitionStatus(status) {
  const petitionSection = document.getElementById('petition-section');

  // Only show for petition status ballots
  if (status.status !== 'petition' || !status.petitionStatus) {
    petitionSection.classList.add('hidden');
    return;
  }

  petitionSection.classList.remove('hidden');

  const petitionStatus = status.petitionStatus;

  // Update progress
  document.getElementById('petition-current').textContent = petitionStatus.current;
  document.getElementById('petition-required').textContent = petitionStatus.required;

  const progressPct = (petitionStatus.current / petitionStatus.required) * 100;
  document.getElementById('petition-progress-fill').style.width = `${Math.min(progressPct, 100)}%`;

  // Check if user can sign
  const userIdentity = await identity.getIdentity();
  const alreadySigned = petitionStatus.signatures.some(s => s.publicKey === userIdentity.publicKey);

  if (alreadySigned) {
    document.getElementById('already-signed-section').classList.remove('hidden');
  } else {
    // Check voter gate
    try {
      const canSign = await api.request('POST', '/api/gates/voter/check', {
        publicKey: userIdentity.publicKey
      });

      if (canSign.allowed) {
        document.getElementById('can-sign-section').classList.remove('hidden');
        document.getElementById('sign-petition-btn').addEventListener('click', handleSignPetition);
      } else {
        document.getElementById('cannot-sign-section').classList.remove('hidden');
        document.getElementById('cannot-sign-reason').textContent =
          canSign.reason || 'You are not eligible to sign this petition.';
      }
    } catch (e) {
      document.getElementById('cannot-sign-section').classList.remove('hidden');
      document.getElementById('cannot-sign-reason').textContent =
        'Unable to check eligibility. Please try again.';
    }
  }

  // Show signatures list
  if (petitionStatus.signatures.length > 0) {
    document.getElementById('signatures-list-section').classList.remove('hidden');
    document.getElementById('signatures-list').innerHTML = petitionStatus.signatures
      .map(s => `<li class="signature-item">${s.publicKey.slice(0, 16)}... <span class="hint">${formatTime(s.timestamp)}</span></li>`)
      .join('');
  }
}

/**
 * Handle petition signing
 */
async function handleSignPetition() {
  const btn = document.getElementById('sign-petition-btn');
  btn.disabled = true;
  btn.textContent = 'Signing...';

  try {
    const userIdentity = await identity.getIdentity();

    // Sign the ballot ID using the crypto module
    const signature = await prestigeCrypto.sign(ballotId, userIdentity.privateKey);

    const result = await api.request('POST', `/api/ballot/${ballotId}/petition`, {
      publicKey: userIdentity.publicKey,
      signature,
    });

    if (result.activated) {
      // Ballot is now active! Reload page
      alert('Petition threshold reached! Voting is now open.');
      location.reload();
    } else {
      // Update UI
      document.getElementById('can-sign-section').classList.add('hidden');
      document.getElementById('already-signed-section').classList.remove('hidden');
      document.getElementById('petition-current').textContent = result.status.current;

      const progressPct = (result.status.current / result.status.required) * 100;
      document.getElementById('petition-progress-fill').style.width = `${Math.min(progressPct, 100)}%`;
    }

  } catch (error) {
    alert('Error signing petition: ' + error.message);
    btn.disabled = false;
    btn.textContent = 'Sign Petition';
  }
}

/**
 * Format timestamp for display
 */
function formatTime(timestamp) {
  const date = new Date(timestamp);
  return date.toLocaleDateString() + ' ' + date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

// Initialize on page load
document.addEventListener('DOMContentLoaded', initVotePage);
