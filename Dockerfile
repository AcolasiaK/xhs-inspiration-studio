FROM node:24-bookworm-slim
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
COPY package.json package-lock.json ./
COPY vendor ./vendor
RUN npm ci --no-audit
COPY . .
RUN npm run build && chown -R node:node /app
ENV NODE_ENV=production APP_MODE=cloud APP_LOCAL_ONLY=0 PORT=3000
USER node
EXPOSE 3000
CMD ["node", "deployment/cloudbase/start.cjs"]
