# Build context: the docs site dir (~/cnc/_sites/sunpride-docs)
FROM nginxinc/nginx-unprivileged:1.27-alpine
COPY --chmod=0644 . /usr/share/nginx/html/
EXPOSE 8080
