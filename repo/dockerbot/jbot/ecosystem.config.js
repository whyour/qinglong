module.exports = {
    apps: [{
        name: "jbot",
        version: "0.3.5",
        cwd: "..",
        script: "python",
        args: "-m jbot",
        autorestart: true,
        watch: ["jbot"],
        ignore_watch: [
            "jbot/__pycache__/*",
            "jbot/bot/__pycache__/*",
            "jbot/diy/__pycache__/*",
            "jbot/*.log",
            "jbot/*/*.log",
            "jbot/requirements.txt",
            "jbot/ecosystem.config.js"
        ],
        watch_delay: 15000,
        interpreter: ""
    }]
}