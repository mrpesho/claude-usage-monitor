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
        .get(['usageData', 'prepaidCredits', 'routineBudget', 'lastUpdated', 'error', 'refreshInterval'])
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
  const BADGE_SOURCES = [
    { key: 'five_hour', label: '5h', color: '#D97706' },
    { key: 'seven_day', label: '7d', color: '#3B82F6' },
    { key: 'seven_day_sonnet', label: 'So', color: '#8B5CF6' },
    { key: 'seven_day_opus', label: 'Op', color: '#EC4899' },
    { key: 'seven_day_omelette', label: 'De', color: '#F472B6' },
    { key: 'omelette_promotional', label: 'DP', color: '#FB923C' },
    { key: 'seven_day_oauth_apps', label: 'OA', color: '#06B6D4' },
    { key: 'seven_day_cowork', label: 'Cw', color: '#10B981' },
    { key: 'iguana_necktie', label: 'Ot', color: '#78716C' },
    { key: 'tangelo', label: 'Tg', color: '#A78BFA' },
    { key: 'routine_runs', label: 'Rn', color: '#EAB308' },
    { key: 'extra_usage', label: 'Ex', color: '#E11D48' },
  ];
  const CYCLE_INTERVAL_MS = 4000;
  let currentBadgeIndex = 0;
  let cycleIntervalId: ReturnType<typeof setInterval> | null = null;

  function startBadgeCycle() {
    if (cycleIntervalId) return;

    cycleIntervalId = setInterval(() => {
      browser.storage.local.get(['usageData', 'badgeVisibility']).then((result) => {
        if (result.usageData) {
          displayNextBadge(result.usageData, (result.badgeVisibility as Record<string, boolean>) || {});
        }
      });
    }, CYCLE_INTERVAL_MS);
  }

  function getBadgeSources(usageData: any): { key: string; label: string; color: string }[] {
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

  function displayNextBadge(usageData: any, badgeVisibility: Record<string, boolean>) {
    const sources = getBadgeSources(usageData);
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
      if (badgeVisibility[source.key] === false) continue;
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

    const { badgeVisibility } = await browser.storage.local.get(['badgeVisibility']);
    const visibility = (badgeVisibility as Record<string, boolean>) || {};
    const sources = getBadgeSources(usageData);

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
