const isContainer = process.env.QL_CONTAINER === 'true';

module.exports = {
  apps: [
    {
      name: 'qinglong',
      max_restarts: 5,
      kill_timeout: 1000,
      wait_ready: true,
      listen_timeout: 5000,
      source_map_support: true,
      time: !isContainer,
      out_file: isContainer ? '/dev/null' : undefined,
      // Do not persist PM2 logs in containers, but keep early startup errors
      // visible through `docker logs` before Winston is initialized.
      error_file: isContainer ? '/proc/1/fd/2' : undefined,
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
