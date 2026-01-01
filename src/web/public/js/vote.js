/**
 * Voting logic for Prestige
 * Handles the commit-reveal voting flow
 */

// Get ballot ID from URL
const pathParts = window.location.pathname.split('/');
const ballotId = pathParts[pathParts.length - 1];

let ballot = null;
let selectedChoice = null;        // For single choice
let selectedChoices = [];         // For approval voting
let rankedChoices = [];           // For ranked choice voting
let choiceScores = {};            // For score voting
let timerInterval = null;

/**
 * Initialize the voting page
 */
async function initVotePage() {
  try {
    await identity.initIdentity();
    await loadBallot();
  } catch (error) {
    console.error('Failed to initialize voting page:', error);
    const loadingCard = document.getElementById('loading-card');
    const errorCard = document.getElementById('error-card');

    if (loadingCard) loadingCard.classList.add('hidden');
    if (errorCard) {
      errorCard.classList.remove('hidden');
      const errorMessage = document.getElementById('error-message');
      if (errorMessage) {
        errorMessage.textContent = 'Failed to initialize. Please refresh the page and try again.';
      }
    }
  }
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

    // Check if we just voted in this session (survives page reload)
    const justVoted = sessionStorage.getItem(`justVoted-${ballotId}`);

    // Show appropriate section based on status
    if (status.status === 'petition') {
      // Ballot is waiting for signatures
      await loadPetitionStatus(status);
    } else if (status.status === 'voting') {
      if (hasVotedLocal) {
        if (justVoted) {
          showJustVotedSection();
        } else {
          showVotedSection(voteData);
        }
      } else {
        showVotingSection();
      }
    } else if (status.status === 'revealing') {
      // Clear the "just voted" flag when entering reveal phase
      sessionStorage.removeItem(`justVoted-${ballotId}`);
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
  const voteType = ballot.voteType?.type ?? 'single';

  // Show vote type indicator
  const voteTypeLabel = document.getElementById('vote-type-label');
  if (voteTypeLabel) {
    const typeLabels = {
      single: 'Single Choice',
      approval: 'Approval Voting (select all you approve)',
      ranked: 'Ranked Choice (drag to rank)',
      score: 'Score Voting (rate each choice)'
    };
    voteTypeLabel.textContent = typeLabels[voteType] || 'Single Choice';
    voteTypeLabel.classList.remove('hidden');
  }

  // Render choices based on vote type
  switch (voteType) {
    case 'approval':
      renderApprovalChoices(choicesList);
      break;
    case 'ranked':
      renderRankedChoices(choicesList);
      break;
    case 'score':
      renderScoreChoices(choicesList);
      break;
    default:
      renderSingleChoices(choicesList);
  }

  section.classList.remove('hidden');

  // Set up form handler
  document.getElementById('vote-form').addEventListener('submit', handleVoteSubmit);
}

/**
 * Render single choice (radio buttons)
 */
function renderSingleChoices(container) {
  container.innerHTML = ballot.choices.map((choice, index) => `
    <li class="choice-item" data-choice="${escapeHtml(choice)}" data-action="select-choice">
      <input type="radio" name="choice" id="choice-${index}" value="${escapeHtml(choice)}">
      <label for="choice-${index}" class="choice-text">${escapeHtml(choice)}</label>
    </li>
  `).join('');
}

/**
 * Render approval voting (checkboxes)
 */
function renderApprovalChoices(container) {
  selectedChoices = [];
  container.innerHTML = ballot.choices.map((choice, index) => `
    <li class="choice-item approval-item" data-choice="${escapeHtml(choice)}" data-action="toggle-approval">
      <input type="checkbox" name="approval" id="choice-${index}" value="${escapeHtml(choice)}">
      <label for="choice-${index}" class="choice-text">${escapeHtml(choice)}</label>
    </li>
  `).join('');
}

/**
 * Render ranked choice (draggable list)
 */
function renderRankedChoices(container) {
  rankedChoices = [];
  const minRankings = ballot.voteType?.minRankings ?? 1;
  const maxRankings = ballot.voteType?.maxRankings ?? ballot.choices.length;

  container.innerHTML = `
    <div class="ranked-instructions">
      <p>Click choices to add them to your ranking (${minRankings}-${maxRankings} required).</p>
    </div>
    <div class="ranked-available" id="ranked-available">
      ${ballot.choices.map((choice, index) => `
        <div class="ranked-choice available" data-choice="${escapeHtml(choice)}" data-action="add-to-ranking">
          <span class="choice-text">${escapeHtml(choice)}</span>
        </div>
      `).join('')}
    </div>
    <div class="ranked-selected-label">Your Ranking:</div>
    <ol class="ranked-selected" id="ranked-selected">
      <li class="ranked-placeholder">Click choices above to rank them</li>
    </ol>
  `;
}

/**
 * Render score voting (sliders)
 */
function renderScoreChoices(container) {
  choiceScores = {};
  const minScore = ballot.voteType?.minScore ?? 0;
  const maxScore = ballot.voteType?.maxScore ?? 10;

  // Initialize all scores to minimum
  ballot.choices.forEach(choice => {
    choiceScores[choice] = minScore;
  });

  container.innerHTML = ballot.choices.map((choice, index) => `
    <li class="choice-item score-item" data-choice="${escapeHtml(choice)}" data-choice-index="${index}">
      <div class="score-header">
        <label for="score-${index}" class="choice-text">${escapeHtml(choice)}</label>
        <span class="score-value" id="score-value-${index}">${minScore}</span>
      </div>
      <input type="range" class="score-slider" id="score-${index}"
        min="${minScore}" max="${maxScore}" value="${minScore}"
        data-action="update-score" data-choice="${escapeHtml(choice)}" data-index="${index}">
      <div class="score-range">
        <span>${minScore}</span>
        <span>${maxScore}</span>
      </div>
    </li>
  `).join('');

  // Enable vote button immediately for score voting
  document.getElementById('vote-btn').disabled = false;
}

/**
 * Handle choice selection (single choice)
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
 * Toggle approval selection (approval voting)
 */
function toggleApproval(element) {
  const choice = element.dataset.choice;
  const checkbox = element.querySelector('input');

  if (selectedChoices.includes(choice)) {
    // Remove from selection
    selectedChoices = selectedChoices.filter(c => c !== choice);
    element.classList.remove('selected');
    checkbox.checked = false;
  } else {
    // Add to selection
    selectedChoices.push(choice);
    element.classList.add('selected');
    checkbox.checked = true;
  }

  // Enable vote button if at least one selected
  document.getElementById('vote-btn').disabled = selectedChoices.length === 0;
}

/**
 * Add choice to ranking (ranked choice voting)
 */
function addToRanking(element) {
  const choice = element.dataset.choice;
  const maxRankings = ballot.voteType?.maxRankings ?? ballot.choices.length;

  // Check if already at max
  if (rankedChoices.length >= maxRankings) {
    return;
  }

  // Add to ranked list
  rankedChoices.push(choice);

  // Hide from available
  element.classList.add('hidden');

  // Update ranked display
  updateRankedDisplay();

  // Check if we can vote
  validateRankedVote();
}

/**
 * Remove choice from ranking
 */
function removeFromRanking(index) {
  const choice = rankedChoices[index];
  rankedChoices.splice(index, 1);

  // Show in available again
  const availableEl = document.querySelector(`#ranked-available [data-choice="${choice}"]`);
  if (availableEl) {
    availableEl.classList.remove('hidden');
  }

  // Update display
  updateRankedDisplay();
  validateRankedVote();
}

/**
 * Move ranked choice up
 */
function moveRankUp(index) {
  if (index === 0) return;
  [rankedChoices[index - 1], rankedChoices[index]] = [rankedChoices[index], rankedChoices[index - 1]];
  updateRankedDisplay();
}

/**
 * Move ranked choice down
 */
function moveRankDown(index) {
  if (index >= rankedChoices.length - 1) return;
  [rankedChoices[index], rankedChoices[index + 1]] = [rankedChoices[index + 1], rankedChoices[index]];
  updateRankedDisplay();
}

/**
 * Update ranked choices display
 */
function updateRankedDisplay() {
  const container = document.getElementById('ranked-selected');

  if (rankedChoices.length === 0) {
    container.innerHTML = '<li class="ranked-placeholder">Click choices above to rank them</li>';
    return;
  }

  container.innerHTML = rankedChoices.map((choice, index) => `
    <li class="ranked-item" data-index="${index}">
      <span class="rank-number">${index + 1}</span>
      <span class="choice-text">${escapeHtml(choice)}</span>
      <div class="rank-controls">
        <button type="button" class="rank-btn" data-action="move-up" data-index="${index}" ${index === 0 ? 'disabled' : ''}>&#9650;</button>
        <button type="button" class="rank-btn" data-action="move-down" data-index="${index}" ${index >= rankedChoices.length - 1 ? 'disabled' : ''}>&#9660;</button>
        <button type="button" class="rank-btn remove" data-action="remove-rank" data-index="${index}">&#10005;</button>
      </div>
    </li>
  `).join('');
}

/**
 * Validate ranked vote meets requirements
 */
function validateRankedVote() {
  const minRankings = ballot.voteType?.minRankings ?? 1;
  document.getElementById('vote-btn').disabled = rankedChoices.length < minRankings;
}

/**
 * Update score for a choice (score voting)
 */
function updateScore(choice, value, index) {
  choiceScores[choice] = parseInt(value, 10);
  document.getElementById(`score-value-${index}`).textContent = value;
}

/**
 * Handle vote submission
 */
async function handleVoteSubmit(e) {
  e.preventDefault();

  const voteType = ballot.voteType?.type ?? 'single';

  // Validate based on vote type
  if (!validateVoteSelection(voteType)) {
    return;
  }

  const btn = document.getElementById('vote-btn');
  btn.disabled = true;
  btn.textContent = 'Casting vote...';

  try {
    // Get voter secret
    const voterSecret = await identity.getVoterSecret(ballotId);

    // Build vote data based on type
    const voteData = buildVoteData(voteType);

    // Generate salt and commitment
    const salt = prestigeCrypto.generateSalt();
    let commitment;

    if (voteType === 'single') {
      // Backwards compatible simple commitment
      commitment = await prestigeCrypto.generateCommitment(selectedChoice, salt);
    } else {
      // Extended vote commitment
      commitment = await prestigeCrypto.generateVoteCommitment(voteData, salt);
    }

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
      choice: getPrimaryChoice(voteType),
      salt,
      nullifier,
      commitment,
      voteData: voteType !== 'single' ? voteData : undefined,
    });

    // Mark as just voted (survives page reload within this session)
    sessionStorage.setItem(`justVoted-${ballotId}`, 'true');

    // Show "just voted" section (not "already voted")
    document.getElementById('voting-section').classList.add('hidden');
    showJustVotedSection();

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
 * Validate vote selection based on type
 */
function validateVoteSelection(voteType) {
  switch (voteType) {
    case 'single':
      if (!selectedChoice) {
        alert('Please select a choice');
        return false;
      }
      return true;

    case 'approval':
      if (selectedChoices.length === 0) {
        alert('Please select at least one choice');
        return false;
      }
      return true;

    case 'ranked':
      const minRankings = ballot.voteType?.minRankings ?? 1;
      if (rankedChoices.length < minRankings) {
        alert(`Please rank at least ${minRankings} choice(s)`);
        return false;
      }
      return true;

    case 'score':
      // Score voting is always valid (all choices have default scores)
      return true;

    default:
      return true;
  }
}

/**
 * Build vote data structure for the given type
 */
function buildVoteData(voteType) {
  switch (voteType) {
    case 'single':
      return { type: 'single', choice: selectedChoice };

    case 'approval':
      return { type: 'approval', choices: [...selectedChoices] };

    case 'ranked':
      return { type: 'ranked', rankings: [...rankedChoices] };

    case 'score':
      return { type: 'score', scores: { ...choiceScores } };

    default:
      return { type: 'single', choice: selectedChoice };
  }
}

/**
 * Get primary choice for storage (for backwards compatibility)
 */
function getPrimaryChoice(voteType) {
  switch (voteType) {
    case 'single':
      return selectedChoice;
    case 'approval':
      return selectedChoices[0] || '';
    case 'ranked':
      return rankedChoices[0] || '';
    case 'score':
      // Return the choice with highest score
      const entries = Object.entries(choiceScores);
      if (entries.length === 0) return '';
      return entries.sort((a, b) => b[1] - a[1])[0][0];
    default:
      return selectedChoice;
  }
}

/**
 * Show "just voted" section (immediately after casting vote)
 */
function showJustVotedSection() {
  const section = document.getElementById('just-voted-section');
  section.classList.remove('hidden');
}

/**
 * Show "already voted" section (on revisit)
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
    const localVoteData = await identity.getVoteData(ballotId);

    if (!localVoteData) {
      throw new Error('No vote data found locally');
    }

    // Build reveal request
    const revealRequest = {
      ballotId,
      nullifier: localVoteData.nullifier,
      choice: localVoteData.choice,
      salt: localVoteData.salt,
    };

    // Include voteData for extended vote types
    if (localVoteData.voteData) {
      revealRequest.voteData = localVoteData.voteData;
    }

    // Submit reveal
    await api.submitReveal(revealRequest);

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

// Clean up timer on page unload to prevent memory leaks
window.addEventListener('beforeunload', () => {
  if (timerInterval) {
    clearInterval(timerInterval);
    timerInterval = null;
  }
});

// Event delegation for choices list (handles all vote type interactions)
document.addEventListener('DOMContentLoaded', () => {
  const choicesList = document.getElementById('choices-list');
  if (choicesList) {
    choicesList.addEventListener('click', (e) => {
      const target = e.target.closest('[data-action]');
      if (!target) return;

      const action = target.dataset.action;
      const li = target.closest('li, .ranked-choice');

      switch (action) {
        case 'select-choice':
          if (li) selectChoice(li);
          break;
        case 'toggle-approval':
          if (li) toggleApproval(li);
          break;
        case 'add-to-ranking':
          if (target) addToRanking(target);
          break;
        case 'move-up':
          moveRankUp(parseInt(target.dataset.index, 10));
          break;
        case 'move-down':
          moveRankDown(parseInt(target.dataset.index, 10));
          break;
        case 'remove-rank':
          removeFromRanking(parseInt(target.dataset.index, 10));
          break;
      }
    });

    // Handle score slider input events
    choicesList.addEventListener('input', (e) => {
      if (e.target.dataset.action === 'update-score') {
        const choice = e.target.dataset.choice;
        const value = e.target.value;
        const index = parseInt(e.target.dataset.index, 10);
        updateScore(choice, value, index);
      }
    });
  }
});

// Initialize on page load
document.addEventListener('DOMContentLoaded', initVotePage);
