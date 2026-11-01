# PostgreSQL 16 with Patroni 4 (etcd v3 as the consensus store). Patroni runs as the postgres user and starts, stops, promotes and rewinds PostgreSQL itself.
FROM postgres:16
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 python3-venv curl ca-certificates \
 && python3 -m venv /opt/patroni \
 && /opt/patroni/bin/pip install --no-cache-dir "patroni[etcd3]==4.1.5" psycopg2-binary \
 && apt-get purge -y --auto-remove && rm -rf /var/lib/apt/lists/*
COPY entrypoint.sh /entrypoint.sh
RUN chmod 755 /entrypoint.sh
USER postgres
ENTRYPOINT ["/entrypoint.sh"]
