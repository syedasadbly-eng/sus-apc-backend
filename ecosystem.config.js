// PM2 Ecosystem File
// Start with: pm2 start ecosystem.config.js
module.exports = {
  apps: [{
    name: 'sus-apc-backend',
    script: 'server.js',
    instances: 1,               // SQLite doesn't support multiple writers
    autorestart: true,
    watch: false,
    max_memory_restart: '500M',
    env: {
      NODE_ENV: 'production',
      PORT: 3001,
      MQTT_HOST: '492260d5d94c4b4e87ade94ae81925e6.s1.eu.hivemq.cloud',
      MQTT_PORT: 8883,
      MQTT_USER: 'sus-dashboard',
      MQTT_PASS: 'SuS-Mqtt#2026!Secure',
      MQTT_TOPIC: 'bus/#',
      DB_PATH: './apc_data.db',
      BUS_CAPACITY: 55,
    },
    // Log files
    error_file: './logs/err.log',
    out_file: './logs/out.log',
    log_date_format: 'YYYY-MM-DD HH:mm:ss',
    merge_logs: true,
  }],
};
