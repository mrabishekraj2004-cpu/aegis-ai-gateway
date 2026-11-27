FROM node:22-alpine
ENV NODE_ENV=production PORT=4174 AEGIS_HOST=0.0.0.0
WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev --no-audit --no-fund && npm cache clean --force \
  && rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx
COPY --chown=node:node server.mjs ./
COPY --chown=node:node src ./src
COPY --chown=node:node migrations ./migrations
COPY --chown=node:node scripts ./scripts
USER node
EXPOSE 4174
CMD ["node", "server.mjs"]
