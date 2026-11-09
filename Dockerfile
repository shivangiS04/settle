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
# Sync schema to Postgres, optionally seed (SEED_ON_START=1), then serve.
CMD ["sh", "-c", "npx prisma db push --skip-generate && if [ \"$SEED_ON_START\" = \"1\" ]; then npm run seed; fi && npx next start -p ${PORT:-3000}"]
