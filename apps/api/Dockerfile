FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    ATLAS_DATA_DIR=/data/workspaces

WORKDIR /app/apps/api
COPY apps/api/requirements.txt .
RUN pip install -r requirements.txt

COPY apps/api/ .
RUN mkdir -p /data/workspaces

EXPOSE 8000
# 0.0.0.0 inside the container; docker-compose publishes the port on 127.0.0.1 only.
CMD ["python", "-m", "uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
