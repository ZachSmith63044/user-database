import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import { addTenantToPgcat, addTenantToCaddy, removeTenantFromPgcat, removeTenantFromCaddy } from './pgcat-integration.js';

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

/**
 * Creates a fixed-size loopback filesystem and mounts it at dataDir.
 * This gives the tenant a hard storage limit enforced by the kernel
 * itself (ENOSPC once full) rather than a soft/periodic check.
 *
 * imagePath ends up at `${dataDir}.img`, sitting on the block volume
 * alongside the tenants directory (not inside dataDir itself, since
 * dataDir is about to become a separate mount point).
 */
function createTenantDataVolume(dataDir, storageMb) {
  const imagePath = `${dataDir}.img`;

  fs.mkdirSync(dataDir, { recursive: true });

  // Create a fixed-size, sparse-then-filled file and format it as ext4.
  execSync(`sudo fallocate -l ${storageMb}M "${imagePath}"`);
  execSync(`sudo mkfs.ext4 -q "${imagePath}"`);

  // Mount it at the tenant's actual data path via a loop device.
  execSync(`sudo mount -o loop "${imagePath}" "${dataDir}"`);

  // The postgres container runs as a specific internal UID - make sure
  // the freshly mounted (root-owned by default) filesystem is writable.
  execSync(`sudo chown -R 999:999 "${dataDir}"`);
}

/**
 * Unmounts and deletes a tenant's loopback storage volume. Safe to call
 * even if the mount was already torn down (e.g. containers already
 * stopped) - unmount failures are swallowed since there may be nothing
 * left to unmount.
 */
function destroyTenantDataVolume(dataDir) {
  const imagePath = `${dataDir}.img`;

  try {
    execSync(`sudo umount "${dataDir}"`);
  } catch (err) {
    console.warn(`Could not unmount ${dataDir} (may already be unmounted): ${err.message}`);
  }

  if (fs.existsSync(imagePath)) {
    execSync(`sudo rm -f "${imagePath}"`);
  }

  // Remove the now-empty mount point directory itself.
  if (fs.existsSync(dataDir)) {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
}

function writeTenantFiles(tenant) {
  const tenantDir = path.join(TENANTS_DIR, tenant.id);       // config: boot volume
  const dataDir = path.join(DATA_DIR, tenant.id, 'postgres'); // data: block volume, loopback-mounted

  fs.mkdirSync(path.join(tenantDir, 'pgbouncer'), { recursive: true });
  fs.mkdirSync(path.join(tenantDir, 'postgres-init'), { recursive: true });

  // Create the tenant's fixed-size storage volume before anything tries
  // to write into it.
  createTenantDataVolume(dataDir, tenant.storage_mb);

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
    PGBOUNCER_PORT: tenant.pgbouncer_port,
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

  return { tenantDir, dataDir };
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
  const tenantId = crypto.randomUUID().replace(/-/g, '').slice(0, 10);

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
    pgbouncer_port: pgbouncerPort,
    storage_mb: tier.storage_mb,
  };

  const { tenantDir, dataDir } = writeTenantFiles(tenant);

  try {
    // Phase 1: start only postgres
    execSync('docker compose up -d postgres', { cwd: tenantDir, stdio: 'inherit' });

    waitForPostgresReady(`tenant-${tenant.id}-postgres`);

    // Phase 2: generate the pgbouncer userlist now that postgres is up
    generateUserlist(tenant, tenantDir);

    // Phase 3: start the rest
    execSync('docker compose up -d', { cwd: tenantDir, stdio: 'inherit' });
  } catch (err) {
    // If anything fails mid-provisioning, clean up the loopback volume
    // rather than leaving an orphaned mount + image file behind.
    console.error('Provisioning failed, cleaning up storage volume:', err.message);
    destroyTenantDataVolume(dataDir);
    fs.rmSync(tenantDir, { recursive: true, force: true });
    throw err;
  }

  // Phase 4: register this tenant with pgcat and Caddy, reload both
  addTenantToPgcat(tenant);
  addTenantToCaddy(tenant);

  return { tenantId, tenantDir, hostPort: tenant.hostPort, pgbouncerPort: tenant.pgbouncer_port };
}

function destroyTenantDatabase(tenantId) {
  const tenantDir = path.join(TENANTS_DIR, tenantId);
  const dataDir = path.join(DATA_DIR, tenantId, 'postgres');

  if (!fs.existsSync(tenantDir)) {
    throw new Error(`Tenant ${tenantId} not found`);
  }

  const dbName = `db_${tenantId}`;
  const tenant = { dbName };

  console.log(`Stopping containers for tenant ${tenantId}...`);
  execSync('docker compose down', { cwd: tenantDir, stdio: 'inherit' });

  removeTenantFromPgcat(tenant);
  removeTenantFromCaddy(tenant);

  destroyTenantDataVolume(dataDir);

  fs.rmSync(tenantDir, { recursive: true, force: true });
  console.log(`Deleted tenant config directory: ${tenantDir}`);

  return { tenantId, destroyed: true };
}

export { createTenantDatabase, destroyTenantDatabase };