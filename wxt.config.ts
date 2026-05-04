import { defineConfig } from 'wxt';

export default defineConfig({
  suppressWarnings: {
    firefoxDataCollection: true,
  },
  manifest: {
    name: 'Claude Usage Monitor',
    description: 'Shows Claude AI usage status in your browser toolbar',
    permissions: ['alarms', 'storage'],
    host_permissions: ['https://claude.ai/*'],
    browser_specific_settings: {
      gecko: {
        id: 'claude-usage-monitor@mrpesho',
        data_collection_permissions: {
          required: ['none'],
        },
      },
    },
    icons: {
      16: 'icons/icon16.png',
      48: 'icons/icon48.png',
      128: 'icons/icon128.png',
    },
    action: {
      default_icon: {
        16: 'icons/icon16.png',
        48: 'icons/icon48.png',
        128: 'icons/icon128.png',
      },
    },
  },
});
