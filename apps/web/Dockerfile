FROM nginx:1.27-alpine
# Static HTML/CSS/JS frontend, no build step.
COPY apps/web/ /usr/share/nginx/html/
# Serves the frontend, and Ollama status on port 8443 (see docker/nginx-web.conf).
COPY docker/nginx-web.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
