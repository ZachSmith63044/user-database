import fs from 'fs';
import { execSync } from 'child_process';

// Path to pgcat's config file on the VM
const PGCAT_TOML_PATH = '/home/ubuntu/pgcat-config/pgcat.toml';

// pgcat admin connection details (port/admin_username match pgcat.toml's [general])
const PGCAT_ADMIN_HOST = '127.0.0.1';
const PGCAT_ADMIN_PORT = 6432;
const PGCAT_ADMIN_USERNAME = 'admin';
const PGCAT_ADMIN_PASSWORD_PATH = '/etc/pgcat/admin_password.txt';

/**
 * Appends a [pools.<dbname>] block for a newly created tenant to pgcat.toml,
 * then tells pgcat to RELOAD so it picks up the new pool without dropping
 * any existing client connections.
 */
function addTenantToPgcat(tenant) {
  const poolName = tenant.dbName; // e.g. db_4dc045502f554131aebb4299bd1b05af

  const poolBlock = `
[pools.${poolName}]
pool_mode = "transaction"

[pools.${poolName}.users.0]
username = "${tenant.dbUser}"
password = "${tenant.dbPassword}"
pool_size = ${tenant.pool_size}

[pools.${poolName}.shards.0]
servers = [["127.0.0.1", ${tenant.pgbouncer_port}, "primary"]]
database = "${poolName}"
`;

  // Guard against double-appending if this tenant is somehow re-provisioned
  const existing = fs.readFileSync(PGCAT_TOML_PATH, 'utf8');
  if (existing.includes(`[pools.${poolName}]`)) {
    console.log(`pgcat.toml already contains pool for ${poolName}, skipping append.`);
  } else {
    fs.appendFileSync(PGCAT_TOML_PATH, poolBlock);
    console.log(`Appended pool block for ${poolName} to pgcat.toml`);
  }

  reloadPgcat();
}

/**
 * Issues RELOAD against pgcat's admin console so it re-reads pgcat.toml
 * live, without dropping existing connections.
 */
function reloadPgcat() {
  const adminPassword = fs.readFileSync(PGCAT_ADMIN_PASSWORD_PATH, 'utf8').trim();

  const cmd = `PGPASSWORD='${adminPassword}' psql -h ${PGCAT_ADMIN_HOST} -p ${PGCAT_ADMIN_PORT} -U ${PGCAT_ADMIN_USERNAME} -d pgcat -c "RELOAD;"`;

  try {
    execSync(cmd, { stdio: 'inherit' });
    console.log('pgcat RELOAD issued successfully.');
  } catch (err) {
    console.error('Failed to reload pgcat:', err.message);
    throw err;
  }
}

export { addTenantToPgcat, reloadPgcat };