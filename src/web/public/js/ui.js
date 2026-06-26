/**
 * Prestige UI helpers
 *
 * Lightweight, dependency-free toast + inline banner system that matches the
 * existing dark theme (uses .alert-* classes from styles.css).
 *
 * Exposed on window.ui:
 *   - showToast(message, type, opts?)   non-blocking, auto-dismissing toast
 *   - showBanner(containerId, message, type)  inline banner inside a container
 *   - clearBanner(containerId)          remove a previously shown banner
 *   - humanizeError(error)              map Error/error codes to plain copy
 *   - showInlineError(elementId, message) attach an inline error under an element
 *   - clearInlineError(elementId)       remove a previously attached inline error
 */
(function () {
  const TOAST_CONTAINER_ID = 'prestige-toast-container';
  const DEFAULT_DURATION_MS = 5000;

  const VALID_TYPES = ['info', 'success', 'warning', 'error'];
  function normalizeType(type) {
    return VALID_TYPES.includes(type) ? type : 'info';
  }

  function ensureToastContainer() {
    let container = document.getElementById(TOAST_CONTAINER_ID);
    if (container) return container;
    container = document.createElement('div');
    container.id = TOAST_CONTAINER_ID;
    container.className = 'toast-container';
    container.setAttribute('role', 'status');
    container.setAttribute('aria-live', 'polite');
    container.setAttribute('aria-atomic', 'false');
    document.body.appendChild(container);
    return container;
  }

  function createCloseButton(onClose) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'toast-close';
    btn.setAttribute('aria-label', 'Dismiss notification');
    btn.innerHTML = '&times;';
    btn.addEventListener('click', onClose);
    return btn;
  }

  /**
   * Show a non-blocking toast.
   * @param {string} message
   * @param {'info'|'success'|'warning'|'error'} [type='info']
   * @param {{duration?: number, sticky?: boolean}} [opts]
   */
  function showToast(message, type = 'info', opts = {}) {
    const container = ensureToastContainer();
    const toastType = normalizeType(type);

    const toast = document.createElement('div');
    toast.className = `toast toast-${toastType}`;
    toast.setAttribute('role', toastType === 'error' ? 'alert' : 'status');

    const text = document.createElement('span');
    text.className = 'toast-message';
    text.textContent = message;
    toast.appendChild(text);

    let timeoutId = null;
    const dismiss = () => {
      if (timeoutId) clearTimeout(timeoutId);
      toast.classList.add('toast-leaving');
      const finish = () => {
        if (toast.parentNode) toast.parentNode.removeChild(toast);
        if (container.childElementCount === 0) {
          container.classList.remove('toast-container-visible');
        }
      };
      // Animate out, then remove. Fall back to immediate removal.
      toast.addEventListener('transitionend', finish, { once: true });
      setTimeout(finish, 250);
    };

    toast.appendChild(createCloseButton(dismiss));
    container.appendChild(toast);
    // Trigger entrance transition on next frame.
    requestAnimationFrame(() => {
      container.classList.add('toast-container-visible');
      toast.classList.add('toast-visible');
    });

    // Errors stay until dismissed; everything else auto-dismisses.
    const sticky = opts.sticky || toastType === 'error';
    if (!sticky) {
      const duration = typeof opts.duration === 'number' ? opts.duration : DEFAULT_DURATION_MS;
      timeoutId = setTimeout(dismiss, duration);
    }

    return { dismiss };
  }

  /**
   * Show an inline banner inside a container element. Replaces any existing
   * banner rendered by this helper in that container.
   * @param {string} containerId
   * @param {string} message
   * @param {'info'|'success'|'warning'|'error'} [type='info']
   */
  function showBanner(containerId, message, type = 'info') {
    const container = document.getElementById(containerId);
    if (!container) return;

    const bannerType = normalizeType(type);
    const existing = container.querySelector('.prestige-inline-banner');
    if (existing) existing.remove();

    const banner = document.createElement('div');
    banner.className = `alert alert-${bannerType} prestige-inline-banner`;
    banner.setAttribute('role', bannerType === 'error' ? 'alert' : 'status');
    banner.style.display = 'flex';
    banner.style.alignItems = 'flex-start';
    banner.style.gap = '0.75rem';

    const text = document.createElement('span');
    text.style.flex = '1';
    text.textContent = message;
    banner.appendChild(text);

    const close = createCloseButton(() => banner.remove());
    close.style.flex = 'none';
    banner.appendChild(close);

    container.prepend(banner);
  }

  function clearBanner(containerId) {
    const container = document.getElementById(containerId);
    if (!container) return;
    const existing = container.querySelector('.prestige-inline-banner');
    if (existing) existing.remove();
  }

  /**
   * Attach an inline error message immediately after a form element.
   * Replaces any previously attached inline error for the same element.
   * @param {string} elementId
   * @param {string} message
   */
  function showInlineError(elementId, message) {
    const target = document.getElementById(elementId);
    if (!target) return;

    const parent = target.parentElement;
    if (!parent) return;

    const existing = parent.querySelector('.prestige-inline-error');
    if (existing) existing.remove();

    const error = document.createElement('p');
    error.className = 'prestige-inline-error';
    error.setAttribute('role', 'alert');
    error.textContent = message;
    // Insert right after the target element (or its wrapper).
    if (target.nextSibling) {
      parent.insertBefore(error, target.nextSibling);
    } else {
      parent.appendChild(error);
    }
  }

  function clearInlineError(elementId) {
    const target = document.getElementById(elementId);
    if (!target) return;
    const parent = target.parentElement;
    if (!parent) return;
    const existing = parent.querySelector('.prestige-inline-error');
    if (existing) existing.remove();
  }

  /**
   * Map an Error (with optional .code / .status) to a plain-English message.
   * Falls back to error.message when no mapping is known.
   * @param {Error & {code?: string, status?: number}} error
   * @returns {string}
   */
  function humanizeError(error) {
    if (!error) return 'Something went wrong. Please try again.';

    // Network / offline first — these have no reliable code.
    if (!navigator.onLine || error.code === 'OFFLINE' || error.status === 503) {
      return "Couldn't reach the server. Check your connection and try again.";
    }

    switch (error.code) {
      case 'INVALID_SIGNATURE':
        return "Your browser identity couldn't be verified. Try again.";
      case 'SIGNATURE_REQUIRED':
        return 'This action needs your browser identity. Refresh and try again.';
      case 'INVALID_CHALLENGE':
        return 'Your sign-in challenge expired. Try again.';
      case 'INVALID_PROOF':
      case 'INSUFFICIENT_TOKENS':
        return "We couldn't verify your eligibility to vote. Try again.";
      case 'TOKEN_REUSED':
        return 'This voting token has already been used.';
      case 'DOUBLE_VOTE':
        return 'You have already voted on this ballot.';
      case 'INELIGIBLE':
      case 'NOT_AUTHORIZED':
      case 'NOT_IN_ALLOWLIST':
      case 'NOT_IN_TRUST_NETWORK':
        return "You're not eligible for this ballot.";
      case 'BALLOT_NOT_FOUND':
      case 'NOT_FOUND':
      case 'RESULTS_NOT_FOUND':
        return "We couldn't find that ballot. Check the link and try again.";
      case 'BALLOT_CLOSED':
      case 'TOO_LATE':
        return 'Voting on this ballot has closed.';
      case 'BALLOT_IN_PETITION':
      case 'PETITION_NOT_MET':
        return 'This ballot needs more petition signatures before voting opens.';
      case 'BALLOT_NOT_REVEALING':
        return 'This ballot is not in its reveal window yet.';
      case 'RESULTS_HIDDEN':
        return 'Results are hidden until voting and reveal are complete.';
      case 'INVALID_COMMITMENT':
      case 'INVALID_REVEAL':
        return 'Your vote could not be processed. Please try again.';
      case 'VALIDATION_ERROR':
        return 'Some details were invalid. Please check your input and try again.';
      default:
        // Fall back to the server message, but strip scary internal wording.
        return error.message || 'Something went wrong. Please try again.';
    }
  }

  window.ui = {
    showToast,
    showBanner,
    clearBanner,
    showInlineError,
    clearInlineError,
    humanizeError,
  };
})();
