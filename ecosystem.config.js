module.exports = {
    apps: [
        {
            name: "muffin",
            script: "dist/index.js",
            instances: 1,
            autorestart: true,
            watch: false,
            max_restarts: 10,
            restart_delay: 5000,
            env: {
                NODE_ENV: "production",
            },
        },
    ],
};
