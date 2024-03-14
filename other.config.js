module.exports = {
  apps: [
    {
      name: 'update',
      max_restarts: 10,
      kill_timeout: 15000,
      wait_ready: true,
      listen_timeout: 10000,
      time: true,
      script: 'static/build/update.js',
    },
  ],
};
