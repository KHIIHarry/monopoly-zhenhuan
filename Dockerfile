FROM node:24-alpine AS dependencies
WORKDIR /app

COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/database/package.json packages/database/package.json
COPY packages/shared/package.json packages/shared/package.json

RUN npm ci

FROM dependencies AS build
WORKDIR /app

ARG NEXT_PUBLIC_API_URL
ENV NEXT_PUBLIC_API_URL=$NEXT_PUBLIC_API_URL

COPY . .

RUN npm run db:generate && npm run build:production

FROM node:24-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/apps/api/package.json ./apps/api/package.json
COPY --from=build /app/apps/api/dist ./apps/api/dist
COPY --from=build /app/packages/database/package.json ./packages/database/package.json
COPY --from=build /app/packages/database/dist ./packages/database/dist
COPY --from=build /app/packages/database/prisma ./packages/database/prisma
COPY --from=build /app/packages/shared/package.json ./packages/shared/package.json
COPY --from=build /app/packages/shared/dist ./packages/shared/dist
COPY --from=build /app/monopoly-zhenhuan_master-data.json ./monopoly-zhenhuan_master-data.json

FROM runtime AS api
USER node
EXPOSE 4000
CMD ["node", "apps/api/dist/server.js"]

FROM runtime AS web
COPY --chown=node:node --from=build /app/apps/web/package.json ./apps/web/package.json
COPY --chown=node:node --from=build /app/apps/web/.next ./apps/web/.next
COPY --chown=node:node --from=build /app/apps/web/public ./apps/web/public
COPY --chown=node:node --from=build /app/apps/web/next.config.ts ./apps/web/next.config.ts

USER node
EXPOSE 3000
CMD ["npm", "run", "start", "-w", "@zhenhuan/web"]
