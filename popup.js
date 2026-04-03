// Claude Usage Monitor - Popup Script

const contentEl = document.getElementById('content');
const refreshBtn = document.getElementById('refreshBtn');

let showRawData = false;
let currentData = null;
let currentRefreshInterval = 5;
let collapsedCards = {};

// Load stored data on popup open
document.addEventListener('DOMContentLoaded', async () => {
  const stored = await chrome.storage.local.get(['disclaimerAccepted', 'collapsedCards']);
  collapsedCards = stored.collapsedCards || {};
  if (!stored.disclaimerAccepted) {
    showDisclaimer();
  } else {
    loadStoredData();
  }
});

function showDisclaimer() {
  refreshBtn.style.display = 'none';
  contentEl.innerHTML = `
    <div class="disclaimer">
      <div class="disclaimer-title">Unofficial Extension</div>
      <div class="disclaimer-text">
        This extension uses <strong>undocumented internal APIs</strong> from claude.ai that are not officially supported by Anthropic.
        <br><br>
        It may <strong>stop working at any time</strong> if Anthropic changes their internal endpoints.
        <br><br>
        Your data stays local and never leaves your browser.
      </div>
      <button class="disclaimer-btn" id="acceptDisclaimer">I Understand</button>
    </div>
  `;

  document.getElementById('acceptDisclaimer').addEventListener('click', async () => {
    await chrome.storage.local.set({ disclaimerAccepted: true });
    refreshBtn.style.display = '';
    loadStoredData();
  });
}

refreshBtn.addEventListener('click', async () => {
  refreshBtn.disabled = true;
  refreshBtn.textContent = 'Loading...';

  showLoading();

  try {
    const result = await chrome.runtime.sendMessage({ action: 'fetchUsage' });
    renderContent(result);
  } catch (error) {
    renderError(error.message);
  } finally {
    refreshBtn.disabled = false;
    refreshBtn.textContent = 'Refresh';
  }
});

async function loadStoredData() {
  try {
    const stored = await chrome.runtime.sendMessage({ action: 'getStoredUsage' });

    if (stored.refreshInterval) {
      currentRefreshInterval = stored.refreshInterval;
    }

    if (stored && (stored.usageData || stored.error)) {
      renderContent(stored);
    } else {
      // No stored data, fetch fresh
      refreshBtn.click();
    }
  } catch (error) {
    renderError(error.message);
  }
}

function showLoading() {
  contentEl.innerHTML = `
    <div class="loading">
      <div class="spinner"></div>
      <p style="margin-top: 8px;">Loading...</p>
    </div>
  `;
}

function renderContent(data) {
  currentData = data;

  if (data.error) {
    renderError(data.error);
    return;
  }

  if (!data.usageData) {
    renderError('No usage data available');
    return;
  }

  renderUsage(data.usageData, data.lastUpdated, data.prepaidCredits);
}

function renderError(message) {
  let hint = '';

  if (message.includes('Not logged in') || message.includes('401') || message.includes('403')) {
    hint = `<div class="error-hint">Please <a href="https://claude.ai" target="_blank">log in to Claude</a> first.</div>`;
  } else if (message.includes('429') || message.includes('Rate limited')) {
    hint = `<div class="error-hint">Claude is rate limiting requests. Check <a href="https://status.claude.com" target="_blank">status.claude.com</a> for outages. Will retry automatically.</div>`;
  } else if (message.includes('fetch')) {
    hint = `<div class="error-hint">Check your internet connection and try again.</div>`;
  }

  contentEl.innerHTML = `
    <div class="error">
      <div class="error-title">Unable to fetch usage</div>
      <div class="error-message">${escapeHtml(message)}</div>
      ${hint}
    </div>
  `;
}

function renderUsage(usageData, lastUpdated, prepaidCredits) {
  let html = '';

  // Try to extract and display usage information
  // The API response structure may vary, so we handle multiple formats

  const usageInfo = parseUsageData(usageData, prepaidCredits);

  if (usageInfo.sections.length > 0) {
    for (const section of usageInfo.sections) {
      html += renderUsageSection(section);
    }
  } else {
    // Fallback: show raw data structure
    html += `
      <div class="usage-section">
        <div class="usage-header">
          <span class="usage-label">Usage Data</span>
        </div>
        <div style="font-size: 12px; color: #888;">
          Data structure not recognized. See raw data below.
        </div>
      </div>
    `;
  }

  // Last updated
  if (lastUpdated) {
    const timeAgo = getTimeAgo(lastUpdated);
    html += `<div class="footer">Last updated: ${timeAgo}</div>`;
  }

  // Settings
  html += `
    <div class="settings">
      <div class="setting-row">
        <span class="setting-label">Auto-refresh</span>
        <select class="setting-select" id="refreshInterval">
          <option value="2" ${currentRefreshInterval === 2 ? 'selected' : ''}>2 min</option>
          <option value="5" ${currentRefreshInterval === 5 ? 'selected' : ''}>5 min</option>
          <option value="10" ${currentRefreshInterval === 10 ? 'selected' : ''}>10 min</option>
          <option value="15" ${currentRefreshInterval === 15 ? 'selected' : ''}>15 min</option>
          <option value="30" ${currentRefreshInterval === 30 ? 'selected' : ''}>30 min</option>
        </select>
      </div>
    </div>
  `;

  // Raw data toggle
  html += `
    <button class="toggle-raw" id="toggleRaw">Show raw data</button>
    <div id="rawDataContainer" style="display: none;">
      <div class="raw-data-label">Usage</div>
      <div class="raw-data" id="rawDataUsage"></div>
      ${prepaidCredits ? `
        <div class="raw-data-label">Prepaid Credits</div>
        <div class="raw-data" id="rawDataPrepaid"></div>
      ` : ''}
    </div>
  `;

  contentEl.innerHTML = html;

  // Set up refresh interval change handler
  const intervalSelect = document.getElementById('refreshInterval');
  intervalSelect.addEventListener('change', async (e) => {
    const newInterval = parseInt(e.target.value, 10);
    currentRefreshInterval = newInterval;
    await chrome.runtime.sendMessage({ action: 'setRefreshInterval', interval: newInterval });
  });

  // Set up card collapse toggles
  document.querySelectorAll('.usage-section[data-key] .usage-header').forEach(header => {
    header.addEventListener('click', async () => {
      const card = header.closest('.usage-section');
      const key = card.dataset.key;
      const isNowCollapsed = card.classList.contains('expanded');
      card.classList.toggle('expanded', !isNowCollapsed);
      card.classList.toggle('collapsed', isNowCollapsed);
      collapsedCards[key] = isNowCollapsed;
      await chrome.storage.local.set({ collapsedCards });
    });
  });

  // Set up raw data toggle
  const toggleBtn = document.getElementById('toggleRaw');
  const rawContainer = document.getElementById('rawDataContainer');

  toggleBtn.addEventListener('click', () => {
    showRawData = !showRawData;
    rawContainer.style.display = showRawData ? 'block' : 'none';
    toggleBtn.textContent = showRawData ? 'Hide raw data' : 'Show raw data';
    document.getElementById('rawDataUsage').textContent = JSON.stringify(usageData, null, 2);
    const prepaidEl = document.getElementById('rawDataPrepaid');
    if (prepaidEl) {
      prepaidEl.textContent = JSON.stringify(prepaidCredits, null, 2);
    }
  });
}

function parseUsageData(data, prepaidCredits) {
  const sections = [];

  // Claude API structure:
  // five_hour: { utilization: number, resets_at: string }
  // seven_day: { utilization: number, resets_at: string }
  // seven_day_opus: { utilization: number, resets_at: string } | null
  // seven_day_sonnet: { utilization: number, resets_at: string } | null

  // Colors match the badge cycling colors in background.js
  const windowConfig = {
    'five_hour': { label: '5-Hour Limit', color: '#D97706' },           // Orange
    'seven_day': { label: '7-Day Overall', color: '#3B82F6' },          // Blue
    'seven_day_sonnet': { label: '7-Day Sonnet', color: '#8B5CF6' },    // Purple
    'seven_day_opus': { label: '7-Day Opus', color: '#EC4899' },        // Pink
    'seven_day_oauth_apps': { label: '7-Day OAuth Apps', color: '#06B6D4' }, // Cyan
    'seven_day_cowork': { label: '7-Day Cowork', color: '#10B981' },    // Green
    'iguana_necktie': { label: 'Other', color: '#78716C' }              // Gray
  };

  const windowOrder = [
    'five_hour', 'seven_day', 'seven_day_sonnet', 'seven_day_opus',
    'seven_day_oauth_apps', 'seven_day_cowork', 'iguana_necktie'
  ];

  for (const key of windowOrder) {
    const window = data[key];
    if (window && window.utilization != null) {
      const config = windowConfig[key];
      sections.push({
        key: key,
        label: config.label,
        color: config.color,
        percentage: window.utilization,
        resetDate: window.resets_at
      });
    }
  }

  // Extra usage has a different structure
  const extraUsage = data.extra_usage;
  if (extraUsage) {
    if (extraUsage.is_enabled) {
      const currencyMap = {
        USD: '$', EUR: '€', GBP: '£', JPY: '¥', CAD: 'C$', AUD: 'A$',
        CHF: 'CHF', CNY: '¥', INR: '₹', RUB: '₽', SEK: 'kr', MXN: 'Mex$', SGD: 'S$'
      };
      const cur = prepaidCredits?.currency;
      const currencySymbol = currencyMap[cur] || cur || '$';
      const fmt = (val) => `${currencySymbol} ${(val / 100).toFixed(2)}`;
      const details = {
        'Monthly Limit': extraUsage.monthly_limit != null ? fmt(extraUsage.monthly_limit) : 'N/A',
        'Used': extraUsage.used_credits != null ? fmt(extraUsage.used_credits) : fmt(0)
      };
      if (prepaidCredits && prepaidCredits.amount != null) {
        details['Balance'] = fmt(prepaidCredits.amount);
      }
      sections.push({
        key: 'extra_usage',
        label: 'Extra Usage',
        color: '#E11D48',
        percentage: extraUsage.monthly_limit ? (extraUsage.used_credits / extraUsage.monthly_limit) * 100 : extraUsage.utilization,
        resetDate: null,
        details: details
      });
    } else {
      sections.push({
        key: 'extra_usage',
        label: 'Extra Usage',
        color: '#78716C',
        disabled: true
      });
    }
  }

  return { sections };
}

function renderUsageSection(section) {
  const isCollapsed = collapsedCards[section.key] === true;
  const stateClass = isCollapsed ? 'collapsed' : 'expanded';

  if (section.disabled) {
    return `
      <div class="usage-section ${stateClass} disabled-section" data-key="${section.key}">
        <div class="usage-header">
          <span class="usage-label">
            <span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${section.color || '#888'};margin-right:6px;"></span>
            ${escapeHtml(section.label)}
            <span class="toggle-arrow">▾</span>
          </span>
          <span class="usage-value" style="color:#666;">Disabled</span>
        </div>
        <div class="usage-body">
          <div class="disabled-hint">Enable extra usage in your Claude account settings</div>
        </div>
      </div>
    `;
  }

  let percentage;

  if (section.percentage !== undefined) {
    percentage = section.percentage;
  } else if (section.used !== undefined && section.limit !== undefined && section.limit > 0) {
    percentage = (section.used / section.limit) * 100;
  } else {
    percentage = null;
  }

  // Use section color, but override to red if critical
  let barColor = section.color || '#10b981';
  if (percentage !== null && percentage >= 90) {
    barColor = '#dc2626'; // Red for critical
  }

  let valueDisplay = '';
  if (section.used !== undefined && section.limit !== undefined) {
    valueDisplay = `${formatNumber(section.used)} / ${formatNumber(section.limit)}`;
    if (section.unit) valueDisplay += ` ${section.unit}`;
  } else if (percentage !== null) {
    valueDisplay = `${percentage.toFixed(1)}%`;
  }

  let html = `
    <div class="usage-section ${stateClass}" data-key="${section.key}">
      <div class="usage-header">
        <span class="usage-label">
          <span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${section.color || '#888'};margin-right:6px;"></span>
          ${escapeHtml(section.label)}
          <span class="toggle-arrow">▾</span>
        </span>
        <span class="usage-value">${valueDisplay}</span>
      </div>
      <div class="usage-body">
  `;

  if (percentage !== null) {
    html += `
      <div class="progress-bar">
        <div class="progress-fill" style="width: ${Math.min(100, percentage)}%; background: ${barColor};"></div>
      </div>
    `;
  }

  // Additional details
  if (section.resetDate || section.details) {
    html += '<div class="details">';
    if (section.resetDate) {
      html += `
        <div class="detail-row">
          <span class="detail-label">Resets</span>
          <span class="detail-value">${formatDate(section.resetDate)}</span>
        </div>
      `;
    }
    if (section.details) {
      for (const [key, value] of Object.entries(section.details)) {
        html += `
          <div class="detail-row">
            <span class="detail-label">${escapeHtml(key)}</span>
            <span class="detail-value">${escapeHtml(String(value))}</span>
          </div>
        `;
      }
    }
    html += '</div>';
  }

  html += '</div></div>';
  return html;
}

function formatNumber(num) {
  if (num >= 1000000) {
    return (num / 1000000).toFixed(1) + 'M';
  }
  if (num >= 1000) {
    return (num / 1000).toFixed(1) + 'K';
  }
  return num.toString();
}

function formatDate(dateStr) {
  try {
    const date = new Date(dateStr);
    const now = new Date();
    const diffMs = date - now;

    // If in the future, show relative time
    if (diffMs > 0) {
      const diffMins = Math.floor(diffMs / 60000);
      const diffHours = Math.floor(diffMins / 60);
      const diffDays = Math.floor(diffHours / 24);

      if (diffDays > 0) {
        const remainingHours = diffHours % 24;
        return `in ${diffDays}d ${remainingHours}h`;
      } else if (diffHours > 0) {
        const remainingMins = diffMins % 60;
        return `in ${diffHours}h ${remainingMins}m`;
      } else {
        return `in ${diffMins}m`;
      }
    }

    // If in the past, show absolute date
    return date.toLocaleDateString(undefined, {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit'
    });
  } catch {
    return dateStr;
  }
}

function getTimeAgo(timestamp) {
  const seconds = Math.floor((Date.now() - timestamp) / 1000);

  if (seconds < 60) return 'just now';
  if (seconds < 3600) return `${Math.floor(seconds / 60)} min ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)} hours ago`;
  return `${Math.floor(seconds / 86400)} days ago`;
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}
