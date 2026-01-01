/**
 * PWA Installation and Service Worker Registration for Prestige
 */

// Service Worker Registration
async function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) {
    console.log('[PWA] Service workers not supported');
    return null;
  }

  try {
    const registration = await navigator.serviceWorker.register('/sw.js', {
      scope: '/',
    });

    console.log('[PWA] Service worker registered:', registration.scope);

    // Check for updates
    registration.addEventListener('updatefound', () => {
      const newWorker = registration.installing;
      console.log('[PWA] New service worker installing...');

      newWorker.addEventListener('statechange', () => {
        if (newWorker.state === 'installed' && navigator.serviceWorker.controller) {
          // New content available
          console.log('[PWA] New content available');
          showUpdateNotification();
        }
      });
    });

    return registration;
  } catch (error) {
    console.error('[PWA] Service worker registration failed:', error);
    return null;
  }
}

// Show update notification to user
function showUpdateNotification() {
  // Dispatch event for UI to handle
  window.dispatchEvent(new CustomEvent('prestige:sw-update'));

  // Also show a simple notification if the UI doesn't handle it
  if (document.getElementById('update-banner')) return;

  const banner = document.createElement('div');
  banner.id = 'update-banner';
  banner.innerHTML = `
    <div style="
      position: fixed;
      bottom: 20px;
      left: 20px;
      right: 20px;
      max-width: 400px;
      margin: 0 auto;
      background: #1a1a24;
      border: 1px solid #6366f1;
      border-radius: 8px;
      padding: 1rem;
      box-shadow: 0 4px 20px rgba(0,0,0,0.5);
      z-index: 9999;
      display: flex;
      align-items: center;
      gap: 1rem;
    ">
      <div style="flex: 1;">
        <div style="font-weight: 500; color: #e8e8ed; margin-bottom: 0.25rem;">Update Available</div>
        <div style="font-size: 0.875rem; color: #8888a0;">Refresh to get the latest version</div>
      </div>
      <button onclick="window.location.reload()" style="
        background: #6366f1;
        color: white;
        border: none;
        padding: 0.5rem 1rem;
        border-radius: 4px;
        cursor: pointer;
        font-size: 0.875rem;
      ">Refresh</button>
      <button onclick="this.parentElement.parentElement.remove()" style="
        background: transparent;
        color: #8888a0;
        border: none;
        padding: 0.5rem;
        cursor: pointer;
        font-size: 1.25rem;
        line-height: 1;
      ">&times;</button>
    </div>
  `;
  document.body.appendChild(banner);
}

// PWA Install Prompt
let deferredPrompt = null;
let installButton = null;

// Listen for install prompt
window.addEventListener('beforeinstallprompt', (e) => {
  console.log('[PWA] Install prompt available');
  e.preventDefault();
  deferredPrompt = e;

  // Dispatch event for UI
  window.dispatchEvent(new CustomEvent('prestige:install-available'));

  // Show install button if it exists
  showInstallButton();
});

// Show install button
function showInstallButton() {
  installButton = document.getElementById('install-btn');
  if (installButton) {
    installButton.classList.remove('hidden');
    installButton.addEventListener('click', promptInstall);
  }
}

// Hide install button
function hideInstallButton() {
  if (installButton) {
    installButton.classList.add('hidden');
  }
}

// Prompt user to install
async function promptInstall() {
  if (!deferredPrompt) {
    console.log('[PWA] No install prompt available');
    return false;
  }

  console.log('[PWA] Showing install prompt');
  deferredPrompt.prompt();

  const { outcome } = await deferredPrompt.userChoice;
  console.log('[PWA] Install outcome:', outcome);

  deferredPrompt = null;
  hideInstallButton();

  return outcome === 'accepted';
}

// Check if app is installed
function isInstalled() {
  // Check display-mode
  if (window.matchMedia('(display-mode: standalone)').matches) {
    return true;
  }

  // Check iOS standalone
  if (window.navigator.standalone === true) {
    return true;
  }

  // Check for TWA
  if (document.referrer.includes('android-app://')) {
    return true;
  }

  return false;
}

// Listen for successful installation
window.addEventListener('appinstalled', () => {
  console.log('[PWA] App installed');
  deferredPrompt = null;
  hideInstallButton();

  // Dispatch event for UI
  window.dispatchEvent(new CustomEvent('prestige:installed'));
});

// ============= Offline Detection =============

// Current online status
let isOnline = navigator.onLine;

// Update online status
function updateOnlineStatus() {
  const wasOnline = isOnline;
  isOnline = navigator.onLine;

  if (wasOnline !== isOnline) {
    console.log('[PWA] Online status changed:', isOnline ? 'online' : 'offline');

    // Dispatch event for UI
    window.dispatchEvent(new CustomEvent('prestige:online-status', {
      detail: { online: isOnline }
    }));

    // Show/hide offline indicator
    updateOfflineIndicator();
  }
}

// Show/hide offline indicator
function updateOfflineIndicator() {
  let indicator = document.getElementById('offline-indicator');

  if (!isOnline) {
    if (!indicator) {
      indicator = document.createElement('div');
      indicator.id = 'offline-indicator';
      indicator.innerHTML = `
        <div style="
          position: fixed;
          top: 0;
          left: 0;
          right: 0;
          background: #f59e0b;
          color: #0a0a0f;
          text-align: center;
          padding: 0.5rem;
          font-size: 0.875rem;
          font-weight: 500;
          z-index: 9999;
        ">
          You're offline. Actions will sync when you reconnect.
        </div>
      `;
      document.body.appendChild(indicator);
      document.body.style.marginTop = '36px';
    }
  } else {
    if (indicator) {
      indicator.remove();
      document.body.style.marginTop = '';
    }
  }
}

// Listen for online/offline events
window.addEventListener('online', updateOnlineStatus);
window.addEventListener('offline', updateOnlineStatus);

// ============= Initialization =============

async function initPWA() {
  // Register service worker
  const registration = await registerServiceWorker();

  // Initialize offline indicator
  updateOfflineIndicator();

  // Initialize offline queue
  if (window.offlineQueue) {
    await window.offlineQueue.init();
  }

  // Initialize notifications
  if (window.notifications) {
    await window.notifications.init();
  }

  console.log('[PWA] Initialized', {
    installed: isInstalled(),
    online: isOnline,
    serviceWorker: !!registration,
  });

  return {
    installed: isInstalled(),
    online: isOnline,
    registration,
  };
}

// Export for use in other scripts
if (typeof window !== 'undefined') {
  window.pwa = {
    init: initPWA,
    registerServiceWorker,
    promptInstall,
    isInstalled,
    isOnline: () => isOnline,
  };

  // Auto-initialize on DOMContentLoaded
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initPWA);
  } else {
    initPWA();
  }
}
