/**
 * Resolve PostgreSQL pool settings from structured runtime fields. No database
 * credentials are assembled into a URL or stored in repository files.
 * @param {Record<string,string|undefined>} env
 */
export function databaseConfigFromEnv(env = process.env) {
  const { AEGIS_DATABASE_HOST: host, AEGIS_DATABASE_PORT: port, AEGIS_DATABASE_NAME: database,
    AEGIS_DATABASE_USER: user, AEGIS_DATABASE_PASSWORD: password } = env;
  if (!host || !port || !database || !user || !password) return null;
  if (!/^[a-zA-Z0-9.-]+$/.test(host)) throw new Error("AEGIS_DATABASE_HOST must be a DNS name or IPv4 address.");
  const numericPort = Number(port);
  if (!Number.isInteger(numericPort) || numericPort < 1 || numericPort > 65535) throw new Error("AEGIS_DATABASE_PORT must be from 1 to 65535.");
  return { host, port: numericPort, database, user, password,
    ...(env.AEGIS_DATABASE_SSL === "true" ? { ssl: { rejectUnauthorized: true } } : {}) };
}
