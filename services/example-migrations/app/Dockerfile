# example-migrations as a container: what its sealed environment builds and runs (service.yaml `environment.app`).
FROM node:22.20.0-alpine3.22
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund --loglevel=error
COPY server.ts ./
USER node
CMD ["node_modules/.bin/tsx", "server.ts"]
