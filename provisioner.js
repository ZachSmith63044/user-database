import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import { addTenantToPgcat, addTenantToCaddy, removeTenantFromPgcat, removeTenantFromCaddy } from './pgcatHandler.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const TEMPLATES_DIR = path.join(__dirname, 'templates');
const TENANTS_DIR = path.join(__dirname, 'tenants');
const DATA_DIR = '/mnt/tenant-data/tenants';

function renderTemplate(templatePath, vars) {
  let content = fs.readFileSync(templatePath, 'utf8');
  for (const [key, value] of Object.entries(vars)) {
    content = content.replaceAll(`{{${key}}}`, String(value));
  }
  return content;
}

function writeTenantFiles(tenant) {
  const tenantDir = path.join(TENANTS_DIR, tenant.id);       // config: boot volume
  const dataDir = path.join(DATA_DIR, tenant.id, 'postgres'); // data: block volume

  fs.mkdirSync(path.join(tenantDir, 'pgbouncer'), { recursive: true });
  fs.mkdirSync(path.join(tenantDir, 'postgres-init'), { recursive: true });
  fs.mkdirSync(dataDir, { recursive: true });

  const vars = {
    TENANT_ID: tenant.id,
    DATA_DIR: dataDir,
    DB_NAME: tenant.dbName,
    DB_USER: tenant.dbUser,
    DB_PASSWORD: tenant.dbPassword,
    SHARED_BUFFERS_MB: tenant.shared_buffers_mb,
    WORK_MEM_MB: tenant.work_mem_mb,
    EFFECTIVE_CACHE_SIZE_MB: tenant.effective_cache_size_mb,
    MAX_SQL_CONNECTIONS: tenant.max_sql_connections,
    MAX_CLIENT_CONNECTIONS: tenant.max_client_connections,
    POOL_SIZE: tenant.pool_size,
    HOST_PORT: tenant.hostPort,
    POSTGRES_RAM_MB: tenant.postgres_ram_mb,
    PGBOUNCER_RAM_MB: tenant.pgbouncer_ram_mb,
    POSTGREST_RAM_MB: tenant.postgrest_ram_mb,
    PGBOUNCER_PORT: tenant.pgbouncer_port
  };

  fs.writeFileSync(
    path.join(tenantDir, 'docker-compose.yml'),
    renderTemplate(path.join(TEMPLATES_DIR, 'docker-compose.yml.template'), vars)
  );
  fs.writeFileSync(
    path.join(tenantDir, 'pgbouncer', 'pgbouncer.ini'),
    renderTemplate(path.join(TEMPLATES_DIR, 'pgbouncer.ini.template'), vars)
  );
  fs.copyFileSync(
    path.join(__dirname, 'postgres-init', '01-pgrst-schema-reload.sql'),
    path.join(tenantDir, 'postgres-init', '01-pgrst-schema-reload.sql')
  );

  return tenantDir;
}

function waitForPostgresReady(containerName, retries = 30, delayMs = 1000, requiredConsecutive = 3) {
  let consecutive = 0;
  for (let i = 0; i < retries; i++) {
    try {
      execSync(`docker exec ${containerName} pg_isready -U postgres`, { stdio: 'pipe' });
      consecutive++;
      console.log(`[readiness] attempt ${i}: OK (consecutive=${consecutive})`);
      if (consecutive >= requiredConsecutive) {
        return true;
      }
    } catch (err) {
      consecutive = 0;
      console.log(`[readiness] attempt ${i}: FAILED - ${err.message}`);
    }
    execSync(`sleep 1`);
  }
  throw new Error('Postgres did not become stably ready in time');
}

function generateUserlist(tenant, tenantDir, retries = 5, delayMs = 1000) {
  const containerName = `tenant-${tenant.id}-postgres`;

  for (let i = 0; i < retries; i++) {
    try {
      const passwd = tenant.dbPassword;

      const userlistContent = `"${tenant.dbUser}" "${passwd}"\n`;
      fs.writeFileSync(path.join(tenantDir, 'pgbouncer', 'userlist.txt'), userlistContent, { mode: 0o644 });
      return;
    } catch (err) {
      if (i === retries - 1) throw err;
      execSync(`sleep ${delayMs / 1000}`);
    }
  }
}

function getUsedPorts() {
  const used = new Set();
  if (!fs.existsSync(TENANTS_DIR)) return used;
  for (const id of fs.readdirSync(TENANTS_DIR)) {
    const composePath = path.join(TENANTS_DIR, id, 'docker-compose.yml');
    if (fs.existsSync(composePath)) {
      const content = fs.readFileSync(composePath, 'utf8');
      const matches = [...content.matchAll(/(\d{4,5}):\d+/g)];
      matches.forEach(m => used.add(Number(m[1])));
    }
  }
  return used;
}

function getNextFreePort(start, used) {
  let port = start;
  while (used.has(port)) port++;
  used.add(port);
  return port;
}

async function createTenantDatabase(tier) {
  const tenantId = Math.random().toString(36).slice(2, 14).padEnd(12, '0');;

  const used = getUsedPorts();
  const hostPort = getNextFreePort(3001, used);
  const pgbouncerPort = getNextFreePort(6433, used);

  const tenant = {
    id: tenantId,
    dbName: `db_${tenantId}`,
    dbUser: 'testuser',
    dbPassword: 'password',
    shared_buffers_mb: tier.shared_buffers_mb,
    work_mem_mb: tier.work_mem_mb,
    effective_cache_size_mb: tier.effective_cache_size_mb,
    max_sql_connections: tier.max_sql_connections,
    max_client_connections: tier.max_client_connections,
    pool_size: tier.pool_size,
    hostPort: hostPort,
    postgres_ram_mb: tier.postgres_ram_mb,
    pgbouncer_ram_mb: tier.pgbouncer_ram_mb,
    postgrest_ram_mb: tier.postgrest_ram_mb,
    pgbouncer_port: pgbouncerPort
  };

  const tenantDir = writeTenantFiles(tenant);

  // Phase 1: start only postgres
  execSync('docker compose up -d postgres', { cwd: tenantDir, stdio: 'inherit' });

  waitForPostgresReady(`tenant-${tenant.id}-postgres`);

  // Phase 2: generate the pgbouncer userlist now that postgres is up
  generateUserlist(tenant, tenantDir);

  // Phase 3: start the rest
  execSync('docker compose up -d', { cwd: tenantDir, stdio: 'inherit' });

  addTenantToPgcat(tenant);
  addTenantToCaddy(tenant);

  return { tenantId, tenantDir, hostPort: tenant.hostPort, pgbouncerPort: tenant.pgbouncer_port };
}

function destroyTenantDatabase(tenantId) {
  const tenantDir = path.join(TENANTS_DIR, tenantId);
  const dataDir = path.join(DATA_DIR, tenantId);

  if (!fs.existsSync(tenantDir)) {
    throw new Error(`Tenant ${tenantId} not found`);
  }

  // Reconstruct minimal tenant info needed to remove it from pgcat/Caddy
  const dbName = `db_${tenantId.replace(/-/g, '')}`;
  const tenant = { dbName };

  // 1. Stop and remove containers + network
  console.log(`Stopping containers for tenant ${tenantId}...`);
  execSync('docker compose down', { cwd: tenantDir, stdio: 'inherit' });

  // 2. Remove from pgcat and Caddy (reloads both)
  removeTenantFromPgcat(tenant);
  removeTenantFromCaddy(tenant);

  // 3. Delete data directory (block volume)
  if (fs.existsSync(dataDir)) {
    fs.rmSync(dataDir, { recursive: true, force: true });
    console.log(`Deleted data directory: ${dataDir}`);
  }

  // 4. Delete tenant config directory (boot volume)
  fs.rmSync(tenantDir, { recursive: true, force: true });
  console.log(`Deleted tenant config directory: ${tenantDir}`);

  // 5. Reminder: DNS record for this tenant's hostname still exists
  //    and is not automatically removed. Clean up manually in Cloudflare,
  //    or extend this function later to call Cloudflare's API directly.
  console.warn(`NOTE: DNS record for ${dbName}.${BASE_DOMAIN} was not removed automatically.`);

  return { tenantId, destroyed: true };
}

export { createTenantDatabase, destroyTenantDatabase };
