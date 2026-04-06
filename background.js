// Claude Usage Monitor - Background Service Worker

const CLAUDE_BASE_URL = 'https://claude.ai';
const DEFAULT_INTERVAL_MINUTES = 5;

// Initialize alarm based on stored interval
async function initAlarm() {
  const { refreshInterval } = await chrome.storage.local.get(['refreshInterval']);
  const interval = refreshInterval || DEFAULT_INTERVAL_MINUTES;
  chrome.alarms.create('updateUsage', { periodInMinutes: interval });
}

initAlarm();

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'updateUsage') {
    fetchUsageData();
  }
});

// Fetch on extension load
chrome.runtime.onStartup.addListener(() => {
  fetchUsageData();
});

chrome.runtime.onInstalled.addListener(() => {
  fetchUsageData();
});

// Listen for messages from popup
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === 'fetchUsage') {
    fetchUsageData().then(sendResponse);
    return true; // Keep channel open for async response
  }
  if (message.action === 'getStoredUsage') {
    chrome.storage.local.get(['usageData', 'prepaidCredits', 'lastUpdated', 'error', 'refreshInterval'], sendResponse);
    return true;
  }
  if (message.action === 'setRefreshInterval') {
    const interval = message.interval;
    chrome.storage.local.set({ refreshInterval: interval }).then(() => {
      // Recreate alarm with new interval
      chrome.alarms.clear('updateUsage').then(() => {
        chrome.alarms.create('updateUsage', { periodInMinutes: interval });
        sendResponse({ success: true });
      });
    });
    return true;
  }
});

async function fetchUsageData() {
  try {
    // Get the organization ID from the bootstrap data
    const bootstrapData = await fetchBootstrapData();

    if (!bootstrapData || !bootstrapData.account) {
      throw new Error('Not logged in to Claude');
    }

    const orgId = bootstrapData.account.memberships?.[0]?.organization?.uuid;
    if (!orgId) {
      throw new Error('Could not find organization ID');
    }

    // Fetch usage data and prepaid credits in parallel
    const [usageData, prepaidCredits] = await Promise.all([
      fetchOrganizationUsage(orgId),
      fetchPrepaidCredits(orgId).catch(() => null)
    ]);

    // Store the data
    const dataToStore = {
      usageData: usageData,
      prepaidCredits: prepaidCredits,
      lastUpdated: Date.now(),
      error: null
    };

    await chrome.storage.local.set(dataToStore);

    // Update badge
    updateBadge(usageData);

    return dataToStore;
  } catch (error) {
    console.error('Error fetching usage data:', error);

    const errorData = {
      usageData: null,
      lastUpdated: Date.now(),
      error: error.message
    };

    await chrome.storage.local.set(errorData);
    updateBadgeError(error.message);

    return errorData;
  }
}

async function fetchWithRetry(url, options = {}, maxRetries = 3) {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const response = await fetch(url, options);

    if (response.status === 429 && attempt < maxRetries) {
      const retryAfter = response.headers.get('retry-after');
      const delay = retryAfter
        ? parseInt(retryAfter, 10) * 1000
        : Math.min(1000 * Math.pow(2, attempt), 10000); // 1s, 2s, 4s (max 10s)
      await new Promise(r => setTimeout(r, delay));
      continue;
    }

    return response;
  }
}

async function fetchBootstrapData() {
  const response = await fetchWithRetry(`${CLAUDE_BASE_URL}/api/bootstrap`, {
    credentials: 'include',
    headers: {
      'Accept': 'application/json',
    }
  });

  if (!response.ok) {
    if (response.status === 401 || response.status === 403) {
      throw new Error('Not logged in');
    }
    if (response.status === 429) {
      throw new Error('Rate limited by Claude (429). Service may be experiencing issues.');
    }
    throw new Error(`Bootstrap failed: ${response.status}`);
  }

  return response.json();
}

async function fetchOrganizationUsage(orgId) {
  const response = await fetchWithRetry(`${CLAUDE_BASE_URL}/api/organizations/${orgId}/usage`, {
    credentials: 'include',
    headers: {
      'Accept': 'application/json',
    }
  });

  if (!response.ok) {
    if (response.status === 429) {
      throw new Error('Rate limited by Claude (429). Service may be experiencing issues.');
    }
    throw new Error(`Usage fetch failed: ${response.status}`);
  }

  return response.json();
}

async function fetchPrepaidCredits(orgId) {
  const response = await fetchWithRetry(`${CLAUDE_BASE_URL}/api/organizations/${orgId}/prepaid/credits`, {
    credentials: 'include',
    headers: {
      'Accept': 'application/json',
    }
  });

  if (!response.ok) {
    return null;
  }

  return response.json();
}

// Badge cycling configuration
const BADGE_SOURCES = [
  { key: 'five_hour', label: '5h', color: '#D97706' },           // Orange - immediate
  { key: 'seven_day', label: '7d', color: '#3B82F6' },           // Blue - overall
  { key: 'seven_day_sonnet', label: 'So', color: '#8B5CF6' },    // Purple - Sonnet
  { key: 'seven_day_opus', label: 'Op', color: '#EC4899' },      // Pink - Opus
  { key: 'seven_day_oauth_apps', label: 'OA', color: '#06B6D4' }, // Cyan - OAuth Apps
  { key: 'seven_day_cowork', label: 'Cw', color: '#10B981' },    // Green - Cowork
  { key: 'iguana_necktie', label: 'Ot', color: '#78716C' },      // Gray - Other
  { key: 'extra_usage', label: 'Ex', color: '#E11D48' }          // Rose - Extra
];
const CYCLE_INTERVAL_MS = 4000;
let currentBadgeIndex = 0;
let cycleIntervalId = null;

function startBadgeCycle() {
  if (cycleIntervalId) return; // Already running

  cycleIntervalId = setInterval(() => {
    chrome.storage.local.get(['usageData', 'badgeVisibility'], (result) => {
      if (result.usageData) {
        displayNextBadge(result.usageData, result.badgeVisibility || {});
      }
    });
  }, CYCLE_INTERVAL_MS);
}

function getUtilization(usageData, key) {
  const data = usageData[key];
  if (!data) return null;
  if (data.utilization != null) return data.utilization;
  // Extra usage: compute from used_credits / monthly_limit
  if (key === 'extra_usage' && data.is_enabled && data.monthly_limit) {
    return Math.round((data.used_credits / data.monthly_limit) * 100);
  }
  return null;
}

function displayNextBadge(usageData, badgeVisibility) {
  // Find next available source
  const startIndex = currentBadgeIndex;
  do {
    currentBadgeIndex = (currentBadgeIndex + 1) % BADGE_SOURCES.length;
    const source = BADGE_SOURCES[currentBadgeIndex];
    if (badgeVisibility[source.key] === false) continue;
    if (getUtilization(usageData, source.key) != null) {
      displayBadgeForSource(usageData, source);
      return;
    }
  } while (currentBadgeIndex !== startIndex);

  // All sources hidden or unavailable
  chrome.action.setBadgeText({ text: '-' });
  chrome.action.setBadgeBackgroundColor({ color: '#888888' });
  chrome.action.setTitle({ title: 'Claude Usage - All sources hidden' });
}

function displayBadgeForSource(usageData, source) {
  const percentage = getUtilization(usageData, source.key);
  if (percentage == null) return;
  const rounded = Math.round(percentage);
  const displayText = rounded >= 100 ? 'L' : `${rounded}`;

  chrome.action.setBadgeText({ text: displayText });

  chrome.action.setBadgeBackgroundColor({ color: source.color });
  chrome.action.setTitle({ title: `Claude Usage - ${source.label}: ${rounded}%` });
}

async function updateBadge(usageData) {
  if (!usageData) {
    chrome.action.setBadgeText({ text: '?' });
    chrome.action.setBadgeBackgroundColor({ color: '#888888' });
    chrome.action.setTitle({ title: 'Claude Usage - No data' });
    return;
  }

  const { badgeVisibility } = await chrome.storage.local.get(['badgeVisibility']);
  const visibility = badgeVisibility || {};

  // Find first available and visible source to display initially
  let found = false;
  for (let i = 0; i < BADGE_SOURCES.length; i++) {
    const source = BADGE_SOURCES[i];
    if (visibility[source.key] === false) continue;
    if (getUtilization(usageData, source.key) != null) {
      currentBadgeIndex = i;
      displayBadgeForSource(usageData, source);
      found = true;
      break;
    }
  }

  if (!found) {
    chrome.action.setBadgeText({ text: '-' });
    chrome.action.setBadgeBackgroundColor({ color: '#888888' });
    chrome.action.setTitle({ title: 'Claude Usage - All sources hidden' });
  }

  // Start cycling through sources
  startBadgeCycle();
}

function updateBadgeError(errorMessage) {
  if (errorMessage.includes('Not logged in') || errorMessage.includes('401')) {
    chrome.action.setBadgeText({ text: '!' });
    chrome.action.setBadgeBackgroundColor({ color: '#f59e0b' }); // Orange for login needed
  } else {
    chrome.action.setBadgeText({ text: 'X' });
    chrome.action.setBadgeBackgroundColor({ color: '#dc2626' }); // Red for errors
  }
}
