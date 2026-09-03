FROM node:22-alpine

WORKDIR /srv/app

COPY --chown=node:node app/server.mjs ./server.mjs
COPY --chown=node:node app/public ./public

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=4173

USER node

EXPOSE 4173

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:4173/api/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"

CMD ["node", "server.mjs"]
