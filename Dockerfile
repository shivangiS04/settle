# Official Playwright image: ships Chromium + all system deps the Verifier Agent needs.
FROM mcr.microsoft.com/playwright:v1.65.0-noble

WORKDIR /app
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

COPY package.json package-lock.json ./
COPY prisma ./prisma
COPY scripts ./scripts
RUN node scripts/use-postgres.mjs && npm ci --include=dev

COPY . .
RUN node scripts/use-postgres.mjs && npx prisma generate && npm run build

EXPOSE 3000
# Sync schema to Postgres, seed only if the DB is empty (safe on every boot), then serve.
CMD ["sh", "-c", "npx prisma db push --skip-generate && npm run seed && npx next start -p ${PORT:-3000}"]
