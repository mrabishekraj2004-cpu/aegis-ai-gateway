FROM node:22-alpine
ENV NODE_ENV=production PORT=4173 AEGIS_HOST=0.0.0.0
WORKDIR /app
COPY --chown=node:node package.json server.mjs ./
COPY --chown=node:node index.html styles.css runtime-config.js ./
COPY --chown=node:node src ./src
USER node
EXPOSE 4173
CMD ["node", "server.mjs"]
