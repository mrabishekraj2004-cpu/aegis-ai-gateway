#!/bin/sh
set -eu
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" \
  --set=app_password="$POSTGRES_APP_PASSWORD" \
  --set=worker_password="$POSTGRES_WORKER_PASSWORD" \
  --set=admin_password="$POSTGRES_ADMIN_PASSWORD" <<'SQL'
CREATE ROLE aegis_runtime NOLOGIN NOSUPERUSER NOBYPASSRLS;
CREATE ROLE aegis_admin NOLOGIN NOSUPERUSER NOBYPASSRLS;
CREATE ROLE aegis_worker NOLOGIN NOSUPERUSER NOBYPASSRLS;
SELECT format('CREATE ROLE aegis_app LOGIN NOSUPERUSER NOBYPASSRLS IN ROLE aegis_runtime PASSWORD %L', :'app_password') \gexec
SELECT format('CREATE ROLE aegis_worker_user LOGIN NOSUPERUSER NOBYPASSRLS IN ROLE aegis_worker PASSWORD %L', :'worker_password') \gexec
SELECT format('CREATE ROLE aegis_admin_user LOGIN NOSUPERUSER NOBYPASSRLS IN ROLE aegis_admin PASSWORD %L', :'admin_password') \gexec
SQL
