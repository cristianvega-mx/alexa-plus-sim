FROM node:24-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY . .
ENV NODE_ENV=production PORT=4000 SIM_BIND=0.0.0.0
EXPOSE 4000
USER node
CMD ["npx", "tsx", "src/server.ts"]
