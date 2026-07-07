/** SSL options for `pg` Pool based on connection string and env. */
export function pgPoolSsl(
  connectionString: string,
): false | { rejectUnauthorized: boolean } {
  if (connectionString.includes('sslmode=disable')) {
    return false;
  }
  if (process.env.PG_SSL_REJECT_UNAUTHORIZED === 'false') {
    return { rejectUnauthorized: false };
  }
  return { rejectUnauthorized: true };
}
