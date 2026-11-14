FROM denoland/deno:2.9.3 AS build

WORKDIR /app/web

COPY . ./

RUN deno install --frozen \
    && PRECOMPRESS=1 deno task build

FROM nginxinc/nginx-unprivileged:alpine

COPY deploy/nginx.conf /etc/nginx/conf.d/default.conf
COPY deploy/security-headers.conf /etc/nginx/snippets/security-headers.conf
COPY --from=build /app/web/dist/ /usr/share/nginx/html/

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
    CMD wget -q -O /dev/null http://127.0.0.1:8080/ || exit 1
