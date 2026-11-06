# Build explicitly (Dockerfile-only context): docker build -t llm-bench-code:py311 - < scorers/Dockerfile
# All submissions run offline in disposable containers; no host execution fallback.
FROM python:3.11-slim@sha256:65bd3d9f1d7fa268dd1909973ba7eb4bdf41f6dcf2cfbe76ba9528b170f3fd79
RUN pip install --no-cache-dir numpy==2.2.6
USER 65534:65534
