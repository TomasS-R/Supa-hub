FROM node:20-alpine AS base

FROM base AS deps
RUN apk add --no-cache libc6-compat
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci

FROM base AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npx prisma generate
RUN npm run build

FROM base AS runner
WORKDIR /app
ENV NODE_ENV production
RUN addgroup --system --gid 1001 nodejs
RUN adduser --system --uid 1001 nextjs
COPY --from=builder /app/public ./public
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder /app/prisma ./prisma
COPY --from=builder /app/src/app/api/auth ./src/app/api/auth
RUN mkdir .next/cache && chown -R nextjs:nodejs .next
COPY --from=builder /app/next.config.js ./

USER nextjs
EXPOSE 3000
ENV PORT 3000
ENV HOSTNAME localhost
CMD ["node", "server.js"]
