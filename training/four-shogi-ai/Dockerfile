FROM python:3.12.14-slim-bookworm@sha256:392307d22300de8b5986851a12d9176dfc0fc073e65bf6523ebd7dcbeb23564e
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 OMP_NUM_THREADS=1
WORKDIR /engine
COPY requirements.txt .
RUN pip install --no-cache-dir --index-url https://download.pytorch.org/whl/cpu -r requirements.txt
COPY dataset.py model.py checkpoint.py inference.py inferenceSmoke.py inferenceTest.py ./
USER 65534:65534
ENTRYPOINT ["python", "inference.py"]
