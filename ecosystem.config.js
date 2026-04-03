// PM2 Configuration for Browser AI
//
// First-time setup (auto-start on reboot):
//   1. Start the app: pm2 start ecosystem.config.js
//   2. Run: pm2 startup
//   3. Copy and run the command it outputs (sudo command)
//   4. Run: pm2 save
//
// Now PM2 will auto-start browser-ai on system reboot.

require('dotenv').config();

module.exports = {
  apps: [
    {
      name: 'browser-ai',
      script: 'dist/index.js',
      node_args: '--max-old-space-size=1536',
      max_memory_restart: '1G',
      autorestart: true,
      max_restarts: 10,
      min_uptime: '15m',
      watch: false,
      kill_timeout: 10000,
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      output: './logs/app.log',
      error: './logs/error.log',
      merge_logs: true,
      env: {
        NODE_ENV: 'production',
        BROWSER_HEADLESS: 'true',
        ...process.env,
      },
    },
  ],
};
