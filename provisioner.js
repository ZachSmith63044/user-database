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

function generateDbPassword() {
  // Alphanumeric only - avoids URL-encoding issues in connection strings
  // and problems with special characters in pgbouncer's userlist.txt.
  return crypto.randomBytes(24).toString('base64').replace(/[^a-zA-Z0-9]/g, '').slice(0, 32);
}

async function createTenantDatabase(tier) {
  const tenantId = crypto.randomUUID().replace(/-/g, '').slice(0, 10);

  const used = getUsedPorts();
  const hostPort = getNextFreePort(3001, used);
  const pgbouncerPort = getNextFreePort(6433, used);

  const tenant = {
    id: tenantId,
    dbName: `db_${tenantId}`,
    dbUser: tier.user_name,
    dbPassword: generateDbPassword(),
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

  return {
    tenantId,
    tenantDir,
    hostPort: tenant.hostPort,
    pgbouncerPort: tenant.pgbouncer_port,
    dbUser: tenant.dbUser,
    dbPassword: tenant.dbPassword,
  };
}

function destroyTenantDatabase(tenantId) {
  const tenantDir = path.join(TENANTS_DIR, tenantId);
  const dataDir = path.join(DATA_DIR, tenantId, 'postgres');

  if (!fs.existsSync(tenantDir)) {
    throw new Error(`Tenant ${tenantId} not found`);
  }

  const dbName = `db_${tenantId}`;
  const tenant = { dbName, tenantId, id: tenantId };

  console.log(`Stopping containers for tenant ${tenantId}...`);
  execSync('docker compose down', { cwd: tenantDir, stdio: 'inherit' });

  removeTenantFromPgcat(tenant);
  removeTenantFromCaddy(tenant);

  destroyTenantDataVolume(dataDir);

  // destroyTenantDataVolume only removes dataDir itself (.../postgres) -
  // also remove the now-empty parent directory (.../<tenantId>).
  const tenantDataParentDir = path.join(DATA_DIR, tenantId);
  if (fs.existsSync(tenantDataParentDir)) {
    fs.rmSync(tenantDataParentDir, { recursive: true, force: true });
  }

  fs.rmSync(tenantDir, { recursive: true, force: true });
  console.log(`Deleted tenant config directory: ${tenantDir}`);

  return { tenantId, destroyed: true };
}

function findNewVolumeDevice(sizeGb, toleranceGb = 0.25) {
  const wantBytes = sizeGb * 1024 * 1024 * 1024;
  const toleranceBytes = toleranceGb * 1024 * 1024 * 1024;

  const cmd = `for d in $(lsblk -ndo NAME,TYPE | awk '$2=="disk"{print $1}'); do
    dev="/dev/$d"
    lsblk -no MOUNTPOINT "$dev" | grep -q . && continue
    actual=$(lsblk -bno SIZE "$dev")
    want=${wantBytes}
    diff=$(( actual > want ? actual - want : want - actual ))
    if [ "$diff" -lt ${toleranceBytes} ]; then
      echo "$dev"
      break
    fi
  done`;

  const result = execSync(cmd, { shell: '/bin/bash', encoding: 'utf8' }).trim();
  return result || null;
}

function getCurrentDataSizeBytes(dataDir) {
  const output = execSync(`sudo du -sb "${dataDir}" | cut -f1`, { encoding: 'utf8' }).trim();
  return parseInt(output, 10);
}

function getFilesystemFreeBytes(mountPath) {
  const output = execSync(`df --output=avail -B1 "${mountPath}" | tail -1`, { encoding: 'utf8' }).trim();
  return parseInt(output, 10);
}

function expandExistingBlockVolume(tenantId) {
  const dataDir = path.join(DATA_DIR, tenantId, 'postgres');

  // Find the actual device currently mounted at this tenant's data path
  const device = execSync(`findmnt -n -o SOURCE "${dataDir}"`, { encoding: 'utf8' }).trim();
  if (!device) {
    throw new Error(`Could not find a mounted device for tenant ${tenantId}`);
  }

  const deviceName = device.replace('/dev/', '');

  // Rescan the device so the kernel picks up the new size
  execSync(`echo 1 | sudo tee /sys/class/block/${deviceName}/device/rescan`);

  // Grow the filesystem in place - online, no unmount, no stopping postgres
  execSync(`sudo resize2fs "${device}"`);

  return { tenantId, device, expanded: true };
}

function expandToBlockStorage(tenantId, sizeGb) {
  const device = findNewVolumeDevice(sizeGb);
  if (!device) {
    throw new Error(`Could not identify a new block volume matching ${sizeGb}GB`);
  }
  console.log(`Found new volume at ${device}`);

  const tenantDir = path.join(TENANTS_DIR, tenantId);
  const dataDir = path.join(DATA_DIR, tenantId, 'postgres');
  const tempMountDir = `${dataDir}-new`;

  if (!fs.existsSync(tenantDir)) {
    throw new Error(`Tenant ${tenantId} not found`);
  }

  // 0. Confirm the current data actually fits on the new device BEFORE
  //    touching anything - matters both for expansion (sanity check)
  //    and especially for future downsizing (where this is the whole
  //    point of the check, not just a safety net).
  const currentDataBytes = getCurrentDataSizeBytes(dataDir);
  const newDeviceBytes = parseInt(
    execSync(`sudo blockdev --getsize64 "${device}"`, { encoding: 'utf8' }).trim(),
    10
  );
  // Leave ~5% headroom for filesystem overhead (inodes, journal, reserved
  // blocks) - an exact byte-for-byte fit would likely fail mid-copy.
  const requiredBytes = currentDataBytes * 1.05;

  if (requiredBytes > newDeviceBytes) {
    throw new Error(
      `Current data (${(currentDataBytes / 1024 / 1024 / 1024).toFixed(2)}GB, ` +
      `+5% headroom = ${(requiredBytes / 1024 / 1024 / 1024).toFixed(2)}GB required) ` +
      `does not fit on new device (${(newDeviceBytes / 1024 / 1024 / 1024).toFixed(2)}GB)`
    );
  }
  console.log(`Size check passed: ${(currentDataBytes / 1024 / 1024 / 1024).toFixed(2)}GB of data fits on ${(newDeviceBytes / 1024 / 1024 / 1024).toFixed(2)}GB device`);

  // 1. Stop postgres so the data directory is in a consistent, safe-to-copy state
  console.log(`Stopping postgres for tenant ${tenantId}...`);
  execSync('docker compose stop postgres', { cwd: tenantDir, stdio: 'inherit' });

  // 2. Format the new device and mount it at a TEMPORARY path, so both
  //    old and new are accessible simultaneously for the copy.
  execSync(`sudo mkfs.ext4 -F "${device}"`);
  execSync(`sudo mkdir -p "${tempMountDir}"`);
  execSync(`sudo mount "${device}" "${tempMountDir}"`);

  // 3. Copy everything from the old data directory into the new device,
  //    preserving permissions/ownership/timestamps. Postgres is stopped,
  //    so this is a safe cold copy of the whole data directory.
  console.log(`Copying data from ${dataDir} to ${tempMountDir}...`);
  execSync(`sudo rsync -a "${dataDir}/" "${tempMountDir}/"`);

  // 4. Unmount both, then remount the new device at the REAL path
  execSync(`sudo umount "${tempMountDir}"`);
  try {
    execSync(`sudo umount "${dataDir}"`);
  } catch (err) {
    console.warn(`Could not unmount old ${dataDir} (may already be unmounted): ${err.message}`);
  }
  execSync(`sudo rmdir "${tempMountDir}"`);

  execSync(`sudo mount "${device}" "${dataDir}"`);
  execSync(`sudo chown -R 999:999 "${dataDir}"`);

  // 5. Make the mount persistent across reboots
  const uuid = execSync(`sudo blkid -s UUID -o value "${device}"`, { encoding: 'utf8' }).trim();
  const fstabLine = `UUID=${uuid} ${dataDir} ext4 defaults,nofail,_netdev 0 2`;
  const fstabContent = fs.readFileSync('/etc/fstab', 'utf8');
  if (!fstabContent.includes(uuid)) {
    execSync(`echo "${fstabLine}" | sudo tee -a /etc/fstab`);
  }

  // 6. Remove the now-orphaned loopback image file (data is safely copied over)
  const oldImagePath = `${dataDir}.img`;
  if (fs.existsSync(oldImagePath)) {
    execSync(`sudo rm -f "${oldImagePath}"`);
  }

  // 7. Restart postgres against the new, larger volume
  console.log(`Starting postgres for tenant ${tenantId}...`);
  execSync('docker compose start postgres', { cwd: tenantDir, stdio: 'inherit' });

  return { tenantId, device, expanded: true };
}

function revertToLoopbackVolume(tenantId, sizeGb) {
  const tenantDir = path.join(TENANTS_DIR, tenantId);
  const dataDir = path.join(DATA_DIR, tenantId, 'postgres');
  const tempMountDir = `${dataDir}-new`;
  const newImagePath = `${dataDir}.img`;

  if (!fs.existsSync(tenantDir)) {
    throw new Error(`Tenant ${tenantId} not found`);
  }

  // 1. Stop postgres so the data directory is in a consistent, safe-to-copy state
  console.log(`Stopping postgres for tenant ${tenantId}...`);
  execSync('docker compose stop postgres', { cwd: tenantDir, stdio: 'inherit' });

  // 2. Create the new loopback file and mount it at a TEMPORARY path,
  //    so old (real block device) and new (loopback) are both
  //    accessible simultaneously for the copy.
  execSync(`sudo fallocate -l ${sizeGb}G "${newImagePath}"`);
  execSync(`sudo mkfs.ext4 -q "${newImagePath}"`);
  execSync(`sudo mkdir -p "${tempMountDir}"`);
  execSync(`sudo mount -o loop "${newImagePath}" "${tempMountDir}"`);

  // 3. Check fit using REAL filesystem-reported free space on the new
  //    loopback filesystem, not an estimate - same pattern as expand.
  const currentDataBytes = getCurrentDataSizeBytes(dataDir);
  const availableBytes = getFilesystemFreeBytes(tempMountDir);
  const requiredBytes = currentDataBytes * 1.02;

  if (requiredBytes > availableBytes) {
    execSync(`sudo umount "${tempMountDir}"`);
    execSync(`sudo rmdir "${tempMountDir}"`);
    execSync(`sudo rm -f "${newImagePath}"`);
    execSync('docker compose start postgres', { cwd: tenantDir, stdio: 'inherit' });
    throw new Error(
      `Current data (${(currentDataBytes / 1024 / 1024 / 1024).toFixed(2)}GB) ` +
      `does not fit on a ${sizeGb}GB loopback volume (${(availableBytes / 1024 / 1024 / 1024).toFixed(2)}GB available after formatting)`
    );
  }
  console.log(`Size check passed: ${(currentDataBytes / 1024 / 1024 / 1024).toFixed(2)}GB fits in ${(availableBytes / 1024 / 1024 / 1024).toFixed(2)}GB available`);

  // 4. Copy everything from the old (block device) data directory into
  //    the new loopback filesystem.
  console.log(`Copying data from ${dataDir} to ${tempMountDir}...`);
  execSync(`sudo rsync -a "${dataDir}/" "${tempMountDir}/"`);

  // 5. Identify the old block device (so it can be released/detached
  //    afterward) before unmounting it.
  const oldDevice = execSync(
    `findmnt -n -o SOURCE "${dataDir}"`,
    { encoding: 'utf8' }
  ).trim();

  // 6. Unmount both, then remount the loopback file at the REAL path
  execSync(`sudo umount "${tempMountDir}"`);
  try {
    execSync(`sudo umount "${dataDir}"`);
  } catch (err) {
    console.warn(`Could not unmount old ${dataDir} (may already be unmounted): ${err.message}`);
  }
  execSync(`sudo rmdir "${tempMountDir}"`);

  execSync(`sudo mount -o loop "${newImagePath}" "${dataDir}"`);
  execSync(`sudo chown -R 999:999 "${dataDir}"`);

  // 7. Remove the fstab entry that pointed at the old block device
  execSync(`sudo sed -i "\\|${dataDir}|d" /etc/fstab`);

  // 8. Restart postgres against the reverted loopback volume
  console.log(`Starting postgres for tenant ${tenantId}...`);
  execSync('docker compose start postgres', { cwd: tenantDir, stdio: 'inherit' });

  return { tenantId, oldDevice, reverted: true };
}

const BACKUP_BUCKET = 'simplexdb-backups';

/**
 * Backs up a single tenant's database (pg_dump, gzipped) and uploads it
 * to Object Storage at <tenantId>/<YYYY-MM-DD>.sql.gz. Returns the
 * object name and size on success.
 */
function backupTenantDatabase(tenantId) {
  const tenantDir = path.join(TENANTS_DIR, tenantId);
  if (!fs.existsSync(tenantDir)) {
    throw new Error(`Tenant ${tenantId} not found`);
  }

  const container = `tenant-${tenantId}-postgres`;
  const dbName = `db_${tenantId}`;
  const dbUser = 'testuser';

  // Confirm the container is actually running before attempting a dump
  const runningContainers = execSync('docker ps --format "{{.Names}}"', { encoding: 'utf8' });
  if (!runningContainers.split('\n').includes(container)) {
    throw new Error(`Container ${container} is not running`);
  }

  const date = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  const objectName = `${tenantId}/${date}.sql.gz`;
  const localBackupPath = `/tmp/${tenantId}-${date}.sql.gz`;

  console.log(`Backing up ${tenantId}...`);
  execSync(
    `docker exec ${container} pg_dump -U ${dbUser} ${dbName} | gzip > "${localBackupPath}"`,
    { shell: '/bin/bash', stdio: 'inherit' }
  );

  const sizeBytes = fs.statSync(localBackupPath).size;
  if (sizeBytes === 0) {
    fs.unlinkSync(localBackupPath);
    throw new Error(`Backup for ${tenantId} produced an empty file - aborting upload`);
  }

  console.log(`Uploading ${objectName} (${(sizeBytes / 1024 / 1024).toFixed(2)}MB)...`);
  execSync(
    `oci os object put --bucket-name ${BACKUP_BUCKET} --file "${localBackupPath}" --name "${objectName}" --auth instance_principal --force`,
    { stdio: 'inherit' }
  );

  fs.unlinkSync(localBackupPath);
  console.log(`Backup complete: ${objectName}`);

  return { tenantId, objectName, sizeBytes, date };
}

export { createTenantDatabase, destroyTenantDatabase, expandToBlockStorage, revertToLoopbackVolume, expandExistingBlockVolume, backupTenantDatabase };