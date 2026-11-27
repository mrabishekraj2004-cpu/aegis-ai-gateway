FROM node:22-alpine
ENV NODE_ENV=production PORT=4173 AEGIS_HOST=0.0.0.0
WORKDIR /app
COPY --chown=node:node . ./
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx
USER node
EXPOSE 4173
CMD ["node", "server.mjs"]
