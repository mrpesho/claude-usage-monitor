// Note: innerHTML is used throughout this file. All user-controlled/API data is
// sanitized via escapeHtml() before insertion. Static HTML strings are hardcoded.

const contentEl = document.getElementById('content')!;
const refreshBtn = document.getElementById('refreshBtn') as HTMLButtonElement;

let showRawData = false;
let currentData: any = null;
let currentRefreshInterval = 5;
let collapsedCards: Record<string, boolean> = {};
let badgeVisibility: Record<string, boolean> = {};

document.addEventListener('DOMContentLoaded', async () => {
  const stored = await browser.storage.local.get(['disclaimerAccepted', 'collapsedCards', 'badgeVisibility']);
  collapsedCards = (stored.collapsedCards as Record<string, boolean>) || {};
  badgeVisibility = (stored.badgeVisibility as Record<string, boolean>) || {};
  if (!stored.disclaimerAccepted) {
    showDisclaimer();
  } else {
    loadStoredData();
  }
});

browser.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && (changes.usageData || changes.prepaidCredits || changes.error)) {
    loadStoredData();
  }
});

function showDisclaimer() {
  refreshBtn.style.display = 'none';
  contentEl.innerHTML = `
    <div class="disclaimer">
      <div class="disclaimer-title">Unofficial Extension</div>
      <div class="disclaimer-text">
        This extension uses <strong>undocumented internal APIs</strong> from claude.ai that <strong>Anthropic does not officially support</strong> for third-party use.
        <br><br>
        It may <strong>stop working at any time</strong> if Anthropic changes their internal endpoints.
        <br><br>
        Your data stays local and never leaves your browser.
      </div>
      <button class="disclaimer-btn" id="acceptDisclaimer">I Understand</button>
    </div>
  `;

  document.getElementById('acceptDisclaimer')!.addEventListener('click', async () => {
    await browser.storage.local.set({ disclaimerAccepted: true });
    refreshBtn.style.display = '';
    loadStoredData();
  });
}

refreshBtn.addEventListener('click', async () => {
  refreshBtn.disabled = true;
  refreshBtn.textContent = 'Loading...';
  showLoading();
  try {
    const result = await browser.runtime.sendMessage({ action: 'fetchUsage' });
    renderContent(result);
  } catch (error: any) {
    renderError(error.message);
  } finally {
    refreshBtn.disabled = false;
    refreshBtn.textContent = 'Refresh';
  }
});

async function loadStoredData() {
  try {
    const stored = await browser.runtime.sendMessage({ action: 'getStoredUsage' });
    if (stored.refreshInterval) {
      currentRefreshInterval = stored.refreshInterval;
    }
    if (stored && (stored.usageData || stored.error)) {
      renderContent(stored);
    } else {
      refreshBtn.click();
    }
  } catch (error: any) {
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

function renderContent(data: any) {
  currentData = data;
  if (data.error) { renderError(data.error); return; }
  if (!data.usageData) { renderError('No usage data available'); return; }
  renderUsage(data.usageData, data.lastUpdated, data.prepaidCredits, data.routineBudget);
}

function renderError(message: string) {
  let hint = '';
  if (message.includes('Not logged in') || message.includes('401')) {
    hint = `<div class="error-hint">Please <a href="https://claude.ai" target="_blank">log in to Claude</a> first.</div>`;
  } else if (message.includes('403')) {
    hint = `<div class="error-hint">Access denied. Try <a href="https://claude.ai" target="_blank">reloading claude.ai</a>.</div>`;
  } else if (message.includes('429') || message.includes('Rate limited')) {
    hint = `<div class="error-hint">Rate limited. Check <a href="https://status.claude.com" target="_blank">status.claude.com</a>.</div>`;
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

function renderUsage(usageData: any, lastUpdated: number, prepaidCredits: any, routineBudget: any) {
  let html = '';
  const usageInfo = parseUsageData(usageData, prepaidCredits);

  if (usageInfo.sections.length > 0) {
    for (const section of usageInfo.sections) {
      html += renderUsageSection(section);
    }
  } else {
    html += `<div class="usage-section"><div style="font-size:12px;color:#888;">Data not recognized. See raw data below.</div></div>`;
  }

  if (lastUpdated) {
    html += `<div class="footer">Last updated: ${escapeHtml(getTimeAgo(lastUpdated))}</div>`;
  }

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
    <button class="toggle-raw" id="toggleRaw">Show raw data</button>
    <div id="rawDataContainer" style="display:none;">
      <div class="raw-data-label">Usage</div>
      <div class="raw-data" id="rawDataUsage"></div>
      ${prepaidCredits ? '<div class="raw-data-label">Prepaid Credits</div><div class="raw-data" id="rawDataPrepaid"></div>' : ''}
      ${routineBudget ? '<div class="raw-data-label">Routine Budget</div><div class="raw-data" id="rawDataRoutine"></div>' : ''}
    </div>
  `;

  contentEl.innerHTML = html;

  (document.getElementById('refreshInterval') as HTMLSelectElement).addEventListener('change', async (e) => {
    const newInterval = parseInt((e.target as HTMLSelectElement).value, 10);
    currentRefreshInterval = newInterval;
    await browser.runtime.sendMessage({ action: 'setRefreshInterval', interval: newInterval });
  });

  document.querySelectorAll('.usage-section[data-key] .usage-header').forEach((header) => {
    header.addEventListener('click', async () => {
      const card = header.closest('.usage-section') as HTMLElement;
      const key = card.dataset.key!;
      const isNowCollapsed = card.classList.contains('expanded');
      card.classList.toggle('expanded', !isNowCollapsed);
      card.classList.toggle('collapsed', isNowCollapsed);
      collapsedCards[key] = isNowCollapsed;
      await browser.storage.local.set({ collapsedCards });
    });
  });

  document.querySelectorAll('.badge-toggle').forEach((toggle) => {
    toggle.addEventListener('click', async (e) => {
      e.stopPropagation();
      const el = toggle as HTMLElement;
      const key = el.dataset.key!;
      const color = el.dataset.color!;
      const isCurrentlyVisible = badgeVisibility[key] !== false;
      badgeVisibility[key] = !isCurrentlyVisible;
      if (badgeVisibility[key]) {
        el.classList.replace('off', 'on');
        el.style.color = color;
        el.title = 'Hide from icon badge';
      } else {
        el.classList.replace('on', 'off');
        el.style.color = '';
        el.title = 'Show in icon badge';
      }
      await browser.storage.local.set({ badgeVisibility });
    });
  });

  const toggleBtn = document.getElementById('toggleRaw')!;
  const rawContainer = document.getElementById('rawDataContainer')!;
  toggleBtn.addEventListener('click', () => {
    showRawData = !showRawData;
    rawContainer.style.display = showRawData ? 'block' : 'none';
    toggleBtn.textContent = showRawData ? 'Hide raw data' : 'Show raw data';
    document.getElementById('rawDataUsage')!.textContent = JSON.stringify(usageData, null, 2);
    const prepaidEl = document.getElementById('rawDataPrepaid');
    if (prepaidEl) prepaidEl.textContent = JSON.stringify(prepaidCredits, null, 2);
    const routineEl = document.getElementById('rawDataRoutine');
    if (routineEl) routineEl.textContent = JSON.stringify(routineBudget, null, 2);
  });
}

interface UsageSection {
  key: string;
  label: string;
  color: string;
  percentage?: number;
  resetDate?: string | null;
  used?: number;
  limit?: number;
  unit?: string;
  details?: Record<string, string>;
  disabled?: boolean;
}

function parseUsageData(data: any, prepaidCredits: any): { sections: UsageSection[] } {
  const sections: UsageSection[] = [];

  const windowConfig: Record<string, { label: string; color: string }> = {
    five_hour:            { label: '5-Hour Limit',      color: '#D97706' },
    seven_day:            { label: '7-Day Overall',     color: '#3B82F6' },
    seven_day_sonnet:     { label: '7-Day Sonnet',      color: '#8B5CF6' },
    seven_day_opus:       { label: '7-Day Opus',        color: '#EC4899' },
    seven_day_omelette:   { label: '7-Day Design',      color: '#F472B6' },
    omelette_promotional: { label: 'Design Promo',      color: '#FB923C' },
    seven_day_oauth_apps: { label: '7-Day OAuth Apps',  color: '#06B6D4' },
    seven_day_cowork:     { label: '7-Day Cowork',      color: '#10B981' },
    iguana_necktie:       { label: 'Other',             color: '#78716C' },
    tangelo:              { label: 'Tangelo',           color: '#A78BFA' },
    routine_runs:         { label: 'Routine Runs (daily)', color: '#0EA5E9' },
  };

  const windowOrder = [
    'five_hour', 'seven_day', 'seven_day_sonnet', 'seven_day_opus',
    'seven_day_omelette', 'omelette_promotional',
    'seven_day_oauth_apps', 'seven_day_cowork', 'iguana_necktie', 'tangelo',
    'routine_runs',
  ];

  for (const key of windowOrder) {
    const win = data[key];
    if (win && win.utilization != null) {
      const config = windowConfig[key];
      const section: UsageSection = {
        key, label: config.label, color: config.color,
        percentage: win.utilization, resetDate: win.resets_at,
      };
      if (win.used !== undefined && win.limit !== undefined) {
        section.used = win.used;
        section.limit = win.limit;
        section.unit = 'runs';
      }
      sections.push(section);
    }
  }

  const extra = data.extra_usage;
  if (extra) {
    if (extra.is_enabled) {
      const currencyMap: Record<string, string> = {
        USD: '$', EUR: '€', GBP: '£', JPY: '¥', CAD: 'C$', AUD: 'A$',
        CHF: 'CHF', CNY: '¥', INR: '₹', RUB: '₽', SEK: 'kr', MXN: 'Mex$', SGD: 'S$',
      };
      const cur = prepaidCredits?.currency;
      const sym = currencyMap[cur] || cur || '$';
      const fmt = (v: number) => `${sym} ${(v / 100).toFixed(2)}`;
      const details: Record<string, string> = {
        'Monthly Limit': extra.monthly_limit != null ? fmt(extra.monthly_limit) : 'N/A',
        'Used': extra.used_credits != null ? fmt(extra.used_credits) : fmt(0),
      };
      if (prepaidCredits?.amount != null) details['Balance'] = fmt(prepaidCredits.amount);
      sections.push({
        key: 'extra_usage', label: 'Extra Usage', color: '#E11D48',
        percentage: extra.monthly_limit
          ? (extra.used_credits / extra.monthly_limit) * 100
          : extra.utilization,
        resetDate: null, details,
      });
    } else {
      sections.push({ key: 'extra_usage', label: 'Extra Usage', color: '#78716C', disabled: true });
    }
  }

  return { sections };
}

function renderUsageSection(section: UsageSection): string {
  const isCollapsed = collapsedCards[section.key] === true;
  const stateClass = isCollapsed ? 'collapsed' : 'expanded';
  const dot = `<span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${section.color || '#888'};margin-right:6px;"></span>`;

  if (section.disabled) {
    return `
      <div class="usage-section ${stateClass} disabled-section" data-key="${section.key}">
        <div class="usage-header">
          <span class="usage-label">${dot}${escapeHtml(section.label)}<span class="toggle-arrow">▾</span></span>
          <span class="usage-value" style="color:#666;">Disabled</span>
        </div>
        <div class="usage-body"><div class="disabled-hint">Enable extra usage in your Claude account settings</div></div>
      </div>`;
  }

  let percentage: number | null = null;
  if (section.percentage !== undefined) {
    percentage = section.percentage;
  } else if (section.used !== undefined && section.limit !== undefined && section.limit > 0) {
    percentage = (section.used / section.limit) * 100;
  }

  const barColor = section.color || '#10b981';
  let valueDisplay = '';
  if (section.used !== undefined && section.limit !== undefined) {
    valueDisplay = `${formatNumber(section.used)} / ${formatNumber(section.limit)}`;
    if (section.unit) valueDisplay += ` ${section.unit}`;
  } else if (percentage !== null) {
    valueDisplay = `${percentage.toFixed(1)}%`;
  }

  const isVisible = badgeVisibility[section.key] !== false;
  const toggleClass = isVisible ? 'on' : 'off';
  const toggleColor = isVisible ? `color:${section.color || '#888'}` : '';
  const toggleTitle = isVisible ? 'Hide from icon badge' : 'Show in icon badge';

  let html = `
    <div class="usage-section ${stateClass}" data-key="${section.key}">
      <div class="usage-header">
        <span class="usage-label">
          ${dot}${escapeHtml(section.label)}
          <span class="badge-toggle ${toggleClass}" data-key="${section.key}" data-color="${section.color || '#888'}" title="${toggleTitle}" style="${toggleColor}">&#x21BB;</span>
          <span class="toggle-arrow">▾</span>
        </span>
        <span class="usage-value">${valueDisplay}</span>
      </div>
      <div class="usage-body">`;

  if (percentage !== null) {
    html += `<div class="progress-bar"><div class="progress-fill" style="width:${Math.min(100, percentage)}%;background:${barColor};"></div></div>`;
  }

  if (section.resetDate || section.details) {
    html += '<div class="details">';
    if (section.resetDate) {
      html += `<div class="detail-row"><span class="detail-label">Resets</span><span class="detail-value">${escapeHtml(formatDate(section.resetDate))}</span></div>`;
    }
    if (section.details) {
      for (const [k, v] of Object.entries(section.details)) {
        html += `<div class="detail-row"><span class="detail-label">${escapeHtml(k)}</span><span class="detail-value">${escapeHtml(String(v))}</span></div>`;
      }
    }
    html += '</div>';
  }

  html += '</div></div>';
  return html;
}

function formatNumber(num: number): string {
  if (num >= 1_000_000) return (num / 1_000_000).toFixed(1) + 'M';
  if (num >= 1_000) return (num / 1_000).toFixed(1) + 'K';
  return num.toString();
}

function formatDate(dateStr: string): string {
  try {
    const date = new Date(dateStr);
    const diffMs = date.getTime() - Date.now();
    if (diffMs > 0) {
      const diffMins = Math.floor(diffMs / 60000);
      const diffHours = Math.floor(diffMins / 60);
      const diffDays = Math.floor(diffHours / 24);
      if (diffDays > 0) return `in ${diffDays}d ${diffHours % 24}h`;
      if (diffHours > 0) return `in ${diffHours}h ${diffMins % 60}m`;
      return `in ${diffMins}m`;
    }
    return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  } catch {
    return dateStr;
  }
}

function getTimeAgo(timestamp: number): string {
  const seconds = Math.floor((Date.now() - timestamp) / 1000);
  if (seconds < 60) return 'just now';
  if (seconds < 3600) return `${Math.floor(seconds / 60)} min ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)} hours ago`;
  return `${Math.floor(seconds / 86400)} days ago`;
}

function escapeHtml(text: string): string {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}
