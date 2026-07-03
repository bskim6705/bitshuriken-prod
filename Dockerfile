# syntax=docker/dockerfile:1
# Matching engine (Python). confluent-kafka ships manylinux wheels for amd64,
# so no build toolchain is needed. KAFKA_BROKER + MATCH_CONFIG_PATH at runtime.
FROM python:3.12-slim
WORKDIR /app
ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1
COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt
COPY . .
CMD ["python", "main.py"]
