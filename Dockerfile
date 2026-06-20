# TestMW Browser Host — thin agent image.
# Only Chromium is needed: the agent merely launches a browser server
# (chromium.launchServer) and bridges it to the relay. All actions/analysis
# run on the TestMW server side, never inside this container.
FROM mcr.microsoft.com/playwright:v1.59.1-noble

WORKDIR /app

# Copy dependency files first for better Docker layer caching.
COPY package.json package-lock.json* ./

# --ignore-scripts: the base image already ships the browsers, so we skip the
# postinstall "playwright install" here and install just Chromium explicitly
# below (keeps the image lean — no firefox/webkit).
RUN npm ci --omit=dev --ignore-scripts

# Ensure Chromium + its system libraries are present. The base
# mcr.microsoft.com/playwright:*-noble already contains them, so in practice
# this is a near-instant no-op (skip already-installed); the step is here in
# case the base is swapped for a slim variant.
RUN npx playwright install --with-deps chromium

# Copy source code.
COPY src/ ./src/
COPY .env.example ./.env.example
COPY entrypoint.sh ./entrypoint.sh
RUN sed -i 's/\r$//' ./entrypoint.sh && chmod +x ./entrypoint.sh

ENTRYPOINT ["sh", "./entrypoint.sh"]
