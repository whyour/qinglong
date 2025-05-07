module.exports = {
  apps: [
    {
      name: 'qinglong',
      max_restarts: 5,
      kill_timeout: 1000,
      wait_ready: true,
      listen_timeout: 5000,
      source_map_support: true,
      time: true,
      script: 'static/build/app.js',
      env: {
        http_proxy: '',
        https_proxy: '',
        HTTP_PROXY: '',
        HTTPS_PROXY: '',
        all_proxy: '',
        ALL_PROXY: '',
      },
    },
  ],
};
