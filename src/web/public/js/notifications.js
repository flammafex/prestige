/**
 * Local Notifications for Prestige
 * Handles notification permissions and local reminders
 *
 * Note: Uses local notifications only (no server-side push) for privacy.
 * Reminders are stored in localStorage and checked when the app is open.
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
    supported: notificationsSupported(),
  };
}

// Export for use in other scripts
if (typeof window !== 'undefined') {
  window.notifications = {
    // Permission
    supported: notificationsSupported,
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

    // Init
    init: initNotifications,
    startReminderChecker,
    stopReminderChecker,

    // Constants
    TYPES: NOTIFICATION_TYPES,
  };
}
