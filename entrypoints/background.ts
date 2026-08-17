import { KNOWN_METRICS, ALL_KNOWN_KEYS, DEFAULT_BADGE_KEYS } from '@/utils/metrics';

export default defineBackground(() => {
  // browser.action (MV3) vs browser.browserAction (MV2/Firefox)
  const action = browser.action ?? (browser as any).browserAction;

  const CLAUDE_BASE_URL = 'https://claude.ai';
  const DEFAULT_INTERVAL_MINUTES = 5;

  async function initAlarm() {
    const result = await browser.storage.local.get(['refreshInterval']);
    const interval = (result.refreshInterval as number) || DEFAULT_INTERVAL_MINUTES;
    browser.alarms.create('updateUsage', { periodInMinutes: interval });
  }

  initAlarm();

  // Open a survey page when the user uninstalls the extension
  const surveyUrl = `https://docs.google.com/forms/d/e/1FAIpQLSeeJZxM7TqG97uUZcR1a-rpw20Q-Xp7IkZVds-85ugqjXKJ3g/viewform?entry.1583116375=${import.meta.env.BROWSER}`;
  browser.runtime.setUninstallURL(surveyUrl);

  browser.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === 'updateUsage') {
      fetchUsageData();
    }
  });

  browser.runtime.onStartup.addListener(() => {
    fetchUsageData();
  });

  browser.runtime.onInstalled.addListener(() => {
    fetchUsageData();
  });

  browser.runtime.onMessage.addListener((message: any, _sender, sendResponse) => {
    if (message.action === 'fetchUsage') {
      fetchUsageData().then(sendResponse);
      return true;
    }
    if (message.action === 'getStoredUsage') {
      browser.storage.local
        .get(['usageData', 'prepaidCredits', 'routineBudget', 'lastUpdated', 'error', 'refreshInterval', 'badgeMode'])
        .then(sendResponse);
      return true;
    }
    if (message.action === 'setRefreshInterval') {
      const interval = message.interval;
      browser.storage.local.set({ refreshInterval: interval }).then(() => {
        browser.alarms.clear('updateUsage').then(() => {
          browser.alarms.create('updateUsage', { periodInMinutes: interval });
          sendResponse({ success: true });
        });
      });
      return true;
    }
    if (message.action === 'setBadgeMode') {
      browser.storage.local.set({ badgeMode: message.mode }).then(() => {
        // Re-render badge with new mode
        browser.storage.local.get(['usageData', 'badgeVisibility', 'showUnknown']).then((result) => {
          const unknownVisible = (result.showUnknown as boolean) || false;
          if (result.usageData) {
            if (message.mode === 'active') {
              stopBadgeCycle();
              displayActiveBadge(result.usageData, (result.badgeVisibility as Record<string, boolean>) || {}, unknownVisible);
            } else {
              const visibility = (result.badgeVisibility as Record<string, boolean>) || {};
              displayNextBadge(result.usageData, visibility, unknownVisible);
              startBadgeCycle();
            }
          }
          sendResponse({ success: true });
        });
      });
      return true;
    }
  });

  async function fetchUsageData() {
    const { disclaimerAccepted } = await browser.storage.local.get(['disclaimerAccepted']);
    if (!disclaimerAccepted) return { usageData: null, error: null };

    try {
      const bootstrapData = await fetchBootstrapData();

      if (!bootstrapData || !bootstrapData.account) {
        throw new Error('Not logged in to Claude');
      }

      const memberships = bootstrapData.account.memberships || [];
      const chatMembership =
        memberships.find((m: any) => m.organization?.capabilities?.includes('chat')) ||
        memberships[0];
      const orgId = chatMembership?.organization?.uuid;
      if (!orgId) {
        throw new Error('Could not find organization ID');
      }

      const [usageData, prepaidCredits, routineBudget] = await Promise.all([
        fetchOrganizationUsage(orgId),
        fetchPrepaidCredits(orgId).catch(() => null),
        fetchRoutineBudget(orgId).catch(() => null),
      ]);

      if (routineBudget) {
        const used = parseInt(routineBudget.used, 10);
        const limit = parseInt(routineBudget.limit, 10);
        usageData.routine_runs = {
          utilization: limit > 0 ? Math.round((used / limit) * 100) : 0,
          resets_at: routineBudget.resets_at,
          used,
          limit,
        };
      }

      const dataToStore = {
        usageData,
        prepaidCredits,
        routineBudget,
        lastUpdated: Date.now(),
        error: null,
      };

      await browser.storage.local.set(dataToStore);
      updateBadge(usageData);

      return dataToStore;
    } catch (error: any) {
      console.error('Error fetching usage data:', error);

      const errorData = {
        usageData: null,
        lastUpdated: Date.now(),
        error: error.message,
      };

      await browser.storage.local.set(errorData);
      updateBadgeError(error.message);

      return errorData;
    }
  }

  async function fetchWithRetry(url: string, options: RequestInit = {}, maxRetries = 3) {
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      const response = await fetch(url, options);

      if (response.status === 429 && attempt < maxRetries) {
        const retryAfter = response.headers.get('retry-after');
        const delay = retryAfter
          ? parseInt(retryAfter, 10) * 1000
          : Math.min(1000 * Math.pow(2, attempt), 10000);
        await new Promise((r) => setTimeout(r, delay));
        continue;
      }

      return response;
    }
    throw new Error('Max retries exceeded');
  }

  async function fetchBootstrapData() {
    const response = await fetchWithRetry(`${CLAUDE_BASE_URL}/api/bootstrap`, {
      credentials: 'include',
      headers: { Accept: 'application/json' },
    });

    if (!response.ok) {
      if (response.status === 401 || response.status === 403) throw new Error('Not logged in');
      if (response.status === 429)
        throw new Error('Rate limited by Claude (429). Service may be experiencing issues.');
      throw new Error(`Bootstrap failed: ${response.status}`);
    }

    return response.json();
  }

  async function fetchOrganizationUsage(orgId: string) {
    const response = await fetchWithRetry(
      `${CLAUDE_BASE_URL}/api/organizations/${orgId}/usage`,
      {
        credentials: 'include',
        headers: { Accept: 'application/json' },
      },
    );

    if (!response.ok) {
      if (response.status === 429)
        throw new Error('Rate limited by Claude (429). Service may be experiencing issues.');
      let body = '';
      try {
        body = await response.text();
      } catch {}
      throw new Error(
        `Usage fetch failed: ${response.status}${body ? ' — ' + body.slice(0, 200) : ''}`,
      );
    }

    return response.json();
  }

  async function fetchRoutineBudget(orgId: string) {
    const response = await fetchWithRetry(`${CLAUDE_BASE_URL}/v1/code/routines/run-budget`, {
      credentials: 'include',
      headers: {
        Accept: 'application/json',
        'Anthropic-Version': '2023-06-01',
        'Anthropic-Beta': 'ccr-triggers-2026-01-30',
        'Anthropic-Client-Platform': 'web_claude_ai',
        'X-Organization-Uuid': orgId,
      },
    });

    if (!response.ok) return null;
    return response.json();
  }

  async function fetchPrepaidCredits(orgId: string) {
    const response = await fetchWithRetry(
      `${CLAUDE_BASE_URL}/api/organizations/${orgId}/prepaid/credits`,
      {
        credentials: 'include',
        headers: { Accept: 'application/json' },
      },
    );

    if (!response.ok) return null;
    return response.json();
  }

  // Badge cycling configuration
  const BADGE_SOURCES = KNOWN_METRICS.map(m => ({
    key: m.key, label: m.badgeLabel, color: m.color,
  }));
  const CYCLE_INTERVAL_MS = 4000;
  let currentBadgeIndex = 0;
  let cycleIntervalId: ReturnType<typeof setInterval> | null = null;

  function startBadgeCycle() {
    if (cycleIntervalId) return;

    cycleIntervalId = setInterval(() => {
      browser.storage.local.get(['usageData', 'badgeVisibility', 'showUnknown']).then((result) => {
        if (result.usageData) {
          displayNextBadge(result.usageData, (result.badgeVisibility as Record<string, boolean>) || {}, (result.showUnknown as boolean) || false);
        }
      });
    }, CYCLE_INTERVAL_MS);
  }

  function stopBadgeCycle() {
    if (cycleIntervalId) {
      clearInterval(cycleIntervalId);
      cycleIntervalId = null;
    }
  }

  function displayActiveBadge(usageData: any, _badgeVisibility: Record<string, boolean>, showUnknown: boolean) {
    const sources = getBadgeSources(usageData, showUnknown);
    const limits = usageData.limits;

    // Find the active limit source (ignore badge visibility — user chose this mode
    // specifically to see the active limit)
    if (Array.isArray(limits)) {
      for (const limit of limits) {
        if (!limit.is_active) continue;

        // Map limit kind to badge source key
        let matchKey: string | null = null;
        if (limit.kind === 'session') matchKey = 'five_hour';
        else if (limit.kind === 'weekly_all') matchKey = 'seven_day';
        else matchKey = `limit_${limit.kind}`;

        const source = sources.find(s => s.key === matchKey);
        if (source && getUtilization(usageData, source.key) != null) {
          displayBadgeForSource(usageData, source);
          return;
        }
      }
    }

    // Fallback: show highest utilization rate-limit source (exclude extra_usage/spend)
    let bestSource: { key: string; label: string; color: string } | null = null;
    let bestUtil = -1;
    for (const source of sources) {
      if (source.key === 'extra_usage') continue;
      const util = getUtilization(usageData, source.key);
      if (util != null && util > bestUtil) {
        bestUtil = util;
        bestSource = source;
      }
    }

    if (bestSource) {
      displayBadgeForSource(usageData, bestSource);
    } else {
      action.setBadgeText({ text: '-' });
      action.setBadgeBackgroundColor({ color: '#888888' });
      action.setTitle({ title: 'Claude Usage - No active metric' });
    }
  }

  function getBadgeSources(usageData: any, showUnknown = false): { key: string; label: string; color: string }[] {
    const sources = [...BADGE_SOURCES];

    // Insert model-scoped limits from limits[] array before extra_usage
    if (Array.isArray(usageData.limits)) {
      const scopedLimits = usageData.limits.filter((l: any) => l.scope?.model || l.scope?.surface);
      const extraIndex = sources.findIndex(s => s.key === 'extra_usage');
      const insertAt = extraIndex !== -1 ? extraIndex : sources.length;
      let offset = 0;
      for (const limit of scopedLimits) {
        const modelName = limit.scope?.model?.display_name || limit.scope?.surface || 'Unknown';
        const key = `limit_${limit.kind}`;
        if (!sources.find(s => s.key === key)) {
          const groupLabel = limit.group === 'session' ? 'Ss' : 'Wk';
          sources.splice(insertAt + offset, 0, {
            key,
            label: `${groupLabel} ${modelName}`,
            color: '#14B8A6',
          });
          offset++;
        }
      }
    }

    // Detect unknown codenames and add them before extra_usage (only if lab toggle is on)
    if (showUnknown) {
      const extraIdx = sources.findIndex(s => s.key === 'extra_usage');
      const insertPos = extraIdx !== -1 ? extraIdx : sources.length;
      let unknownOffset = 0;
      for (const key of Object.keys(usageData)) {
        if (ALL_KNOWN_KEYS.has(key)) continue;
        const val = usageData[key];
        if (val && typeof val === 'object' && val.utilization != null) {
          const shortLabel = key.slice(0, 2).toUpperCase();
          sources.splice(insertPos + unknownOffset, 0, {
            key, label: shortLabel, color: '#78716C',
          });
          unknownOffset++;
        }
      }
    }

    return sources;
  }

  function getUtilization(usageData: any, key: string): number | null {
    const data = usageData[key];
    if (!data) {
      // Check limits array for dynamic keys (limit_weekly_scoped etc.)
      if (key.startsWith('limit_') && Array.isArray(usageData.limits)) {
        const kind = key.replace('limit_', '');
        const limit = usageData.limits.find((l: any) => l.kind === kind);
        if (limit) return limit.percent;
      }
      return null;
    }
    if (data.utilization != null) return data.utilization;
    if (key === 'extra_usage') {
      // Use spend.percent if available
      if (usageData.spend?.enabled) return usageData.spend.percent || 0;
      if (data.is_enabled && data.monthly_limit) {
        return Math.round((data.used_credits / data.monthly_limit) * 100);
      }
    }
    return null;
  }

  function displayNextBadge(usageData: any, badgeVisibility: Record<string, boolean>, showUnknown = false) {
    const sources = getBadgeSources(usageData, showUnknown);
    if (sources.length === 0) {
      action.setBadgeText({ text: '-' });
      action.setBadgeBackgroundColor({ color: '#888888' });
      action.setTitle({ title: 'Claude Usage - No data' });
      return;
    }

    const startIndex = currentBadgeIndex;
    do {
      currentBadgeIndex = (currentBadgeIndex + 1) % sources.length;
      const source = sources[currentBadgeIndex];
      const isVisible = source.key in badgeVisibility ? badgeVisibility[source.key] : DEFAULT_BADGE_KEYS.has(source.key);
      if (!isVisible) continue;
      if (getUtilization(usageData, source.key) != null) {
        displayBadgeForSource(usageData, source);
        return;
      }
    } while (currentBadgeIndex !== startIndex);

    action.setBadgeText({ text: '-' });
    action.setBadgeBackgroundColor({ color: '#888888' });
    action.setTitle({ title: 'Claude Usage - All sources hidden' });
  }

  function displayBadgeForSource(usageData: any, source: { key: string; label: string; color: string }) {
    const percentage = getUtilization(usageData, source.key);
    if (percentage == null) return;
    const rounded = Math.round(percentage);
    const displayText = rounded >= 100 ? 'L' : `${rounded}`;

    action.setBadgeText({ text: displayText });
    action.setBadgeBackgroundColor({ color: source.color });
    action.setTitle({ title: `Claude Usage - ${source.label}: ${rounded}%` });
  }

  async function updateBadge(usageData: any) {
    if (!usageData) {
      action.setBadgeText({ text: '?' });
      action.setBadgeBackgroundColor({ color: '#888888' });
      action.setTitle({ title: 'Claude Usage - No data' });
      return;
    }

    const { badgeVisibility, badgeMode, showUnknown } = await browser.storage.local.get(['badgeVisibility', 'badgeMode', 'showUnknown']);
    const visibility = (badgeVisibility as Record<string, boolean>) || {};
    const unknownVisible = (showUnknown as boolean) || false;

    if (badgeMode === 'active') {
      stopBadgeCycle();
      displayActiveBadge(usageData, visibility, unknownVisible);
      return;
    }

    const sources = getBadgeSources(usageData, unknownVisible);

    let found = false;
    for (let i = 0; i < sources.length; i++) {
      const source = sources[i];
      if (visibility[source.key] === false) continue;
      if (getUtilization(usageData, source.key) != null) {
        currentBadgeIndex = i;
        displayBadgeForSource(usageData, source);
        found = true;
        break;
      }
    }

    if (!found) {
      action.setBadgeText({ text: '-' });
      action.setBadgeBackgroundColor({ color: '#888888' });
      action.setTitle({ title: 'Claude Usage - All sources hidden' });
    }

    startBadgeCycle();
  }

  function updateBadgeError(errorMessage: string) {
    if (errorMessage.includes('Not logged in') || errorMessage.includes('401')) {
      action.setBadgeText({ text: '!' });
      action.setBadgeBackgroundColor({ color: '#f59e0b' });
    } else {
      action.setBadgeText({ text: 'X' });
      action.setBadgeBackgroundColor({ color: '#dc2626' });
    }
  }
});
