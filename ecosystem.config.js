module.exports = {
  apps: [
    {
      name: 'schedule',
      max_restarts: 10,
      kill_timeout: 15000,
      wait_ready: true,
      listen_timeout: 10000,
      source_map_support: true,
      time: true,
      script: 'static/build/schedule/index.js',
    },
    {
      name: 'public',
      max_restarts: 10,
      kill_timeout: 15000,
      wait_ready: true,
      listen_timeout: 10000,
      source_map_support: true,
      time: true,
      script: 'static/build/public.js',
    },
    {
      name: 'panel',
      max_restarts: 10,
      kill_timeout: 15000,
      wait_ready: true,
      listen_timeout: 10000,
      source_map_support: true,
      time: true,
      script: 'static/build/app.js',
    },
  ],
};
