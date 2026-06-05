// ecosystem.example.config.js — Template. Copy to ecosystem.config.js and replace placeholder values.
// ecosystem.config.js is gitignored and must never be committed.
module.exports = {
  apps: [{
    name: 'etoro-bot',
    script: 'src/index.js',
    watch: false,
    restart_delay: 5000,
    max_restarts: 10,
    env: {
      NODE_ENV: 'production',
      BOT_SECRET: 'REPLACE_WITH_64_HEX_CHARS'
    },
    log_date_format: 'YYYY-MM-DD HH:mm:ss',
    error_file: 'logs/error.log',
    out_file: 'logs/out.log'
  }]
};
