/**
 * Push Notifications for Prestige
 * Handles notification permissions, subscriptions, and local reminders
 */

// Notification types
const NOTIFICATION_TYPES = {
  REVEAL_REMINDER: 'reveal-reminder',
  BALLOT_ENDING: 'ballot-ending',
  RESULTS_READY: 'results-ready',
  VOTE_SYNCED: 'vote-synced',
};

// Check if notifications are supported
function notificationsSupported() {
  return 'Notification' in window && 'serviceWorker' in navigator;
}

// Check if push is supported
function pushSupported() {
  return 'PushManager' in window;
}

// Get current notification permission
function getPermission() {
  if (!notificationsSupported()) return 'unsupported';
  return Notification.permission;
}

// Request notification permission
async function requestPermission() {
  if (!notificationsSupported()) {
    console.log('[Notifications] Not supported in this browser');
    return 'unsupported';
  }

  try {
    const permission = await Notification.requestPermission();
    console.log('[Notifications] Permission:', permission);
    return permission;
  } catch (e) {
    console.error('[Notifications] Permission request failed:', e);
    return 'denied';
  }
}

// Show a local notification
async function showNotification(title, options = {}) {
  if (getPermission() !== 'granted') {
    console.log('[Notifications] Permission not granted');
    return false;
  }

  const defaultOptions = {
    icon: '/icon-192.png',
    badge: '/icon-192.png',
    vibrate: [100, 50, 100],
    tag: 'prestige-notification',
    renotify: true,
  };

  const mergedOptions = { ...defaultOptions, ...options };

  try {
    if ('serviceWorker' in navigator) {
      const registration = await navigator.serviceWorker.ready;
      await registration.showNotification(title, mergedOptions);
      return true;
    } else {
      new Notification(title, mergedOptions);
      return true;
    }
  } catch (e) {
    console.error('[Notifications] Failed to show notification:', e);
    return false;
  }
}

// ============= Reminder System =============

const REMINDERS_KEY = 'prestige-reminders';

// Get all scheduled reminders
function getReminders() {
  try {
    const stored = localStorage.getItem(REMINDERS_KEY);
    return stored ? JSON.parse(stored) : [];
  } catch (e) {
    return [];
  }
}

// Save reminders
function saveReminders(reminders) {
  localStorage.setItem(REMINDERS_KEY, JSON.stringify(reminders));
}

// Schedule a reveal reminder
function scheduleRevealReminder(ballotId, ballotQuestion, revealDeadline) {
  const reminders = getReminders();

  // Remove existing reminder for this ballot
  const filtered = reminders.filter(r => r.ballotId !== ballotId);

  // Add new reminder (30 minutes before deadline)
  const reminderTime = revealDeadline - (30 * 60 * 1000);

  if (reminderTime > Date.now()) {
    filtered.push({
      id: `reveal-${ballotId}`,
      type: NOTIFICATION_TYPES.REVEAL_REMINDER,
      ballotId,
      ballotQuestion,
      triggerAt: reminderTime,
      deadline: revealDeadline,
      created: Date.now(),
    });

    saveReminders(filtered);
    console.log('[Notifications] Scheduled reveal reminder for:', ballotId);
  }

  return filtered;
}

// Schedule a ballot ending reminder
function scheduleBallotEndingReminder(ballotId, ballotQuestion, votingDeadline) {
  const reminders = getReminders();

  // Remove existing reminder for this ballot
  const filtered = reminders.filter(r => r.ballotId !== ballotId || r.type !== NOTIFICATION_TYPES.BALLOT_ENDING);

  // Add new reminder (1 hour before deadline)
  const reminderTime = votingDeadline - (60 * 60 * 1000);

  if (reminderTime > Date.now()) {
    filtered.push({
      id: `ending-${ballotId}`,
      type: NOTIFICATION_TYPES.BALLOT_ENDING,
      ballotId,
      ballotQuestion,
      triggerAt: reminderTime,
      deadline: votingDeadline,
      created: Date.now(),
    });

    saveReminders(filtered);
    console.log('[Notifications] Scheduled ballot ending reminder for:', ballotId);
  }

  return filtered;
}

// Cancel a reminder
function cancelReminder(ballotId, type = null) {
  const reminders = getReminders();

  const filtered = reminders.filter(r => {
    if (r.ballotId !== ballotId) return true;
    if (type && r.type !== type) return true;
    return false;
  });

  saveReminders(filtered);
  return filtered;
}

// Check and trigger due reminders
async function checkReminders() {
  const reminders = getReminders();
  const now = Date.now();
  const dueReminders = [];
  const remainingReminders = [];

  for (const reminder of reminders) {
    if (reminder.triggerAt <= now) {
      dueReminders.push(reminder);
    } else {
      remainingReminders.push(reminder);
    }
  }

  // Save remaining reminders
  saveReminders(remainingReminders);

  // Trigger due reminders
  for (const reminder of dueReminders) {
    await triggerReminder(reminder);
  }

  return dueReminders.length;
}

// Trigger a specific reminder
async function triggerReminder(reminder) {
  const { type, ballotId, ballotQuestion } = reminder;

  let title, body, url;

  switch (type) {
    case NOTIFICATION_TYPES.REVEAL_REMINDER:
      title = 'Time to Reveal Your Vote';
      body = `Don't forget to reveal your vote on "${truncate(ballotQuestion, 50)}"`;
      url = `/b/${ballotId}`;
      break;

    case NOTIFICATION_TYPES.BALLOT_ENDING:
      title = 'Voting Ending Soon';
      body = `Voting on "${truncate(ballotQuestion, 50)}" ends in 1 hour`;
      url = `/b/${ballotId}`;
      break;

    case NOTIFICATION_TYPES.RESULTS_READY:
      title = 'Results Are In';
      body = `Results for "${truncate(ballotQuestion, 50)}" are now available`;
      url = `/results/${ballotId}`;
      break;

    default:
      return;
  }

  await showNotification(title, {
    body,
    tag: `prestige-${type}-${ballotId}`,
    data: { url, ballotId, type },
  });
}

// Truncate text helper
function truncate(text, maxLength) {
  if (text.length <= maxLength) return text;
  return text.slice(0, maxLength - 3) + '...';
}

// ============= Push Subscription =============

// Get VAPID public key from server
async function getVapidPublicKey() {
  try {
    const response = await fetch('/api/push/vapid-public-key');
    if (response.ok) {
      const data = await response.json();
      return data.publicKey;
    }
  } catch (e) {
    console.log('[Notifications] VAPID key not available');
  }
  return null;
}

// Subscribe to push notifications
async function subscribeToPush() {
  if (!pushSupported()) {
    console.log('[Notifications] Push not supported');
    return null;
  }

  const permission = await requestPermission();
  if (permission !== 'granted') {
    return null;
  }

  try {
    const registration = await navigator.serviceWorker.ready;
    const vapidPublicKey = await getVapidPublicKey();

    if (!vapidPublicKey) {
      console.log('[Notifications] Push notifications not configured on server');
      return null;
    }

    const subscription = await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(vapidPublicKey),
    });

    // Send subscription to server
    await fetch('/api/push/subscribe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(subscription),
    });

    console.log('[Notifications] Push subscription created');
    return subscription;
  } catch (e) {
    console.error('[Notifications] Push subscription failed:', e);
    return null;
  }
}

// Unsubscribe from push notifications
async function unsubscribeFromPush() {
  if (!pushSupported()) return false;

  try {
    const registration = await navigator.serviceWorker.ready;
    const subscription = await registration.pushManager.getSubscription();

    if (subscription) {
      await subscription.unsubscribe();

      // Notify server
      await fetch('/api/push/unsubscribe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ endpoint: subscription.endpoint }),
      });

      console.log('[Notifications] Push subscription removed');
      return true;
    }
  } catch (e) {
    console.error('[Notifications] Unsubscribe failed:', e);
  }

  return false;
}

// Get current push subscription
async function getPushSubscription() {
  if (!pushSupported()) return null;

  try {
    const registration = await navigator.serviceWorker.ready;
    return await registration.pushManager.getSubscription();
  } catch (e) {
    return null;
  }
}

// Convert base64 to Uint8Array for VAPID
function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - base64String.length % 4) % 4);
  const base64 = (base64String + padding)
    .replace(/-/g, '+')
    .replace(/_/g, '/');

  const rawData = window.atob(base64);
  const outputArray = new Uint8Array(rawData.length);

  for (let i = 0; i < rawData.length; ++i) {
    outputArray[i] = rawData.charCodeAt(i);
  }

  return outputArray;
}

// ============= Initialization =============

// Start the reminder checker
let reminderInterval = null;

function startReminderChecker() {
  if (reminderInterval) return;

  // Check reminders every minute
  reminderInterval = setInterval(checkReminders, 60 * 1000);

  // Also check immediately
  checkReminders();

  console.log('[Notifications] Reminder checker started');
}

function stopReminderChecker() {
  if (reminderInterval) {
    clearInterval(reminderInterval);
    reminderInterval = null;
    console.log('[Notifications] Reminder checker stopped');
  }
}

// Initialize notifications
async function initNotifications() {
  // Start reminder checker if permission granted
  if (getPermission() === 'granted') {
    startReminderChecker();
  }

  return {
    permission: getPermission(),
    pushSupported: pushSupported(),
  };
}

// Export for use in other scripts
if (typeof window !== 'undefined') {
  window.notifications = {
    // Permission
    supported: notificationsSupported,
    pushSupported,
    getPermission,
    requestPermission,

    // Notifications
    show: showNotification,

    // Reminders
    scheduleRevealReminder,
    scheduleBallotEndingReminder,
    cancelReminder,
    getReminders,
    checkReminders,

    // Push
    subscribeToPush,
    unsubscribeFromPush,
    getPushSubscription,

    // Init
    init: initNotifications,
    startReminderChecker,
    stopReminderChecker,

    // Constants
    TYPES: NOTIFICATION_TYPES,
  };
}
