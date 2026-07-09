module.exports = {
  apps: [
    {
      name: 'dreamdb',
      script: 'server.js',
      cwd: '/home/claude/dreamdb',
      out_file: '/home/claude/dreamdb/logs/out.log',
      error_file: '/home/claude/dreamdb/logs/error.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      autorestart: true,
      watch: false,
    },
  ],
};
