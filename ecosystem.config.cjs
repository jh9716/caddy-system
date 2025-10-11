// ecosystem.config.cjs
module.exports = {
  apps: [
    {
      name: "verthill",
      cwd: "C:/caddy-system",
      script: "./node_modules/next/dist/bin/next",
      args: "start -p 3000",
      env: {
        NODE_ENV: "production"
      }
    }
  ]
};
