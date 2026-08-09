// Single source of truth for known usage metrics.
// Add or remove entries here — both popup and badge pick them up automatically.

export interface MetricConfig {
  key: string;
  label: string;       // Full label for popup cards
  badgeLabel: string;   // Short label for toolbar badge
  color: string;
}

export const KNOWN_METRICS: MetricConfig[] = [
  { key: 'five_hour',            label: '5-Hour Limit',         badgeLabel: '5h', color: '#D97706' },
  { key: 'seven_day',            label: '7-Day Overall',        badgeLabel: '7d', color: '#3B82F6' },
  { key: 'seven_day_sonnet',     label: '7-Day Sonnet',         badgeLabel: 'So', color: '#8B5CF6' },
  { key: 'seven_day_opus',       label: '7-Day Opus',           badgeLabel: 'Op', color: '#EC4899' },
  { key: 'seven_day_omelette',   label: '7-Day Design',         badgeLabel: 'De', color: '#F472B6' },
  { key: 'omelette_promotional', label: 'Design Promo',         badgeLabel: 'DP', color: '#FB923C' },
  { key: 'seven_day_oauth_apps', label: '7-Day OAuth Apps',     badgeLabel: 'OA', color: '#06B6D4' },
  { key: 'seven_day_cowork',     label: '7-Day Cowork',         badgeLabel: 'Cw', color: '#10B981' },
  // Unknown codenames — commented out until identified. Keeping dedicated colors.
  // { key: 'iguana_necktie',       label: 'Other',                badgeLabel: 'Ot', color: '#78716C' },
  // { key: 'tangelo',              label: 'Tangelo',              badgeLabel: 'Tg', color: '#A78BFA' },
  { key: 'routine_runs',         label: 'Routine Runs (daily)', badgeLabel: 'Rn', color: '#EAB308' },
  { key: 'extra_usage',          label: 'Extra Usage',          badgeLabel: 'Ex', color: '#E11D48' },
];

// Keys that are not metrics (structural/container fields in the API response)
export const STRUCTURAL_KEYS = new Set(['limits', 'spend', 'member_dashboard_available']);

// Quick lookup by key
export const KNOWN_METRICS_MAP = new Map(KNOWN_METRICS.map(m => [m.key, m]));

// Set of all known keys (metrics + structural) for unknown detection
export const ALL_KNOWN_KEYS = new Set([
  ...KNOWN_METRICS.map(m => m.key),
  ...STRUCTURAL_KEYS,
]);
