import fs from 'fs';
import { execSync } from 'child_process';

// Path to pgcat's config file on the VM
const PGCAT_TOML_PATH = '/home/ubuntu/pgcat-config/pgcat.toml';

// pgcat admin connection details (port/admin_username match pgcat.toml's [general])
const PGCAT_ADMIN_HOST = '127.0.0.1';
const PGCAT_ADMIN_PORT = 6432;
const PGCAT_ADMIN_USERNAME = 'admin';
const PGCAT_ADMIN_PASSWORD_PATH = '/etc/pgcat/admin_password.txt';

// Path to Caddy's config file on the VM
const CADDYFILE_PATH = '/etc/caddy/Caddyfile';
const TLS_CERT_PATH = '/opt/tls-certs/fullchain.pem';
const TLS_KEY_PATH = '/opt/tls-certs/privkey.pem';
const BASE_DOMAIN = 'simplexdb.com';

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

/**
 * Removes a tenant's [pools.<dbname>] block from pgcat.toml (including its
 * nested [pools.<dbname>.users.0] and [pools.<dbname>.shards.0] sub-blocks),
 * then reloads pgcat.
 */
function removeTenantFromPgcat(tenant) {
  const poolName = tenant.dbName;
  const existing = fs.readFileSync(PGCAT_TOML_PATH, 'utf8');

  // Matches from "[pools.<name>]" up to (but not including) the next
  // top-level "[pools." or "[general]" section header, or end of file.
  const blockRegex = new RegExp(
    `\\n?\\[pools\\.${poolName}\\][\\s\\S]*?(?=\\n\\[pools\\.|\\n\\[general\\]|$)`,
    'g'
  );

  if (!existing.includes(`[pools.${poolName}]`)) {
    console.log(`pgcat.toml has no pool for ${poolName}, nothing to remove.`);
    return;
  }

  const updated = existing.replace(blockRegex, '');
  fs.writeFileSync(PGCAT_TOML_PATH, updated);
  console.log(`Removed pool block for ${poolName} from pgcat.toml`);

  reloadPgcat();
}

/**
 * Removes a tenant's site block from Caddy's Caddyfile, then reloads Caddy.
 */
function removeTenantFromCaddy(tenant) {
  const hostname = `${tenant.dbName}.${BASE_DOMAIN}`;
  const existing = fs.existsSync(CADDYFILE_PATH)
    ? fs.readFileSync(CADDYFILE_PATH, 'utf8')
    : '';

  if (!existing.includes(hostname)) {
    console.log(`Caddyfile has no block for ${hostname}, nothing to remove.`);
    return;
  }

  // Matches from "<hostname> {" through its closing "}"
  const blockRegex = new RegExp(`\\n?${hostname} \\{[\\s\\S]*?\\n\\}\\n?`, 'g');
  const updated = existing.replace(blockRegex, '');
  fs.writeFileSync(CADDYFILE_PATH, updated);
  console.log(`Removed Caddy site block for ${hostname}`);

  reloadCaddy();
}

export {
  addTenantToPgcat,
  reloadPgcat,
  addTenantToCaddy,
  removeTenantFromPgcat,
  removeTenantFromCaddy,
};

/**
 * Appends a site block for a newly created tenant to Caddy's Caddyfile,
 * proxying <tenant-hostname>.simplexdb.com to that tenant's PostgREST
 * container, then reloads Caddy so it picks up the change with zero
 * downtime for existing sites.
 */
function addTenantToCaddy(tenant) {
  const hostname = `${tenant.dbName}.${BASE_DOMAIN}`;

  const siteBlock = `
${hostname} {
    tls ${TLS_CERT_PATH} ${TLS_KEY_PATH}
    reverse_proxy localhost:${tenant.hostPort}
}
`;

  const existing = fs.existsSync(CADDYFILE_PATH)
    ? fs.readFileSync(CADDYFILE_PATH, 'utf8')
    : '';

  if (existing.includes(hostname)) {
    console.log(`Caddyfile already contains a block for ${hostname}, skipping append.`);
  } else {
    fs.appendFileSync(CADDYFILE_PATH, siteBlock);
    console.log(`Appended Caddy site block for ${hostname}`);
  }

  reloadCaddy();
}

/**
 * Validates and reloads Caddy's config without dropping existing connections.
 */
function reloadCaddy() {
  try {
    execSync(`caddy validate --config ${CADDYFILE_PATH}`, { stdio: 'inherit' });
    execSync('sudo systemctl reload caddy', { stdio: 'inherit' });
    console.log('Caddy reloaded successfully.');
  } catch (err) {
    console.error('Failed to reload Caddy:', err.message);
    throw err;
  }
}