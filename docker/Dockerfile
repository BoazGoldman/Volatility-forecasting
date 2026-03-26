FROM python:3.11-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

WORKDIR /app

# System deps for scientific python wheels (kept minimal).
RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt /app/requirements.txt
# Some Windows setups may create UTF-16 text files; normalize to UTF-8 for pip.
RUN python -c "from pathlib import Path; p=Path('/app/requirements.txt'); b=p.read_bytes(); \
needs=(b.count(b'\\x00')>0); \
txt=(b.decode('utf-16') if needs else b.decode('utf-8')); \
p.write_text(txt, encoding='utf-8', newline='\\n') if needs else None"
RUN pip install --no-cache-dir -r /app/requirements.txt

COPY main.py /app/main.py
COPY src /app/src
COPY api /app/api

# Optional: where the loop writes DB + JSON exports.
RUN mkdir -p /app/data /app/web/public

CMD ["python", "-u", "main.py"]
