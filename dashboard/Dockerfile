FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt \
    && groupadd --system --gid 10001 dashboard \
    && useradd --system --uid 10001 --gid 10001 dashboard
COPY app.py .

USER 10001
EXPOSE 8080
CMD ["python", "app.py"]
