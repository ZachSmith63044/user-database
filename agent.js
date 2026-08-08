import express from 'express';
import { findNewVolumeDevice, createTenantDatabase, destroyTenantDatabase, expandToBlockStorage, revertToLoopbackVolume, expandExistingBlockVolume, backupTenantDatabase, restoreTenantFromBackup, DATA_DIR } from './provisioner.js';
import path from 'path';
import { execSync } from 'child_process';

const app = express();
app.use(express.json());

// Bind to localhost only for now — swap to the WireGuard IP once that's set up
const PORT = 4000;
const HOST = '0.0.0.0';

app.delete('/tenants/:tenantId', async (req, res) => {
  try {
    const result = destroyTenantDatabase(req.params.tenantId);
    res.json(result);
  } catch (err) {
    console.error('Failed to destroy tenant:', err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/tenants', async (req, res) => {
  try {
    const { tier, tenantId } = req.body;
    if (!tier) {
      return res.status(400).json({ error: 'Missing "tier" in request body' });
    }
    const result = await createTenantDatabase(tier, tenantId || null);
    res.json(result);
  } catch (err) {
    console.error('Failed to create tenant:', err);
    res.status(500).json({ error: err.message });
  }
});

app.put('/tenants/:tenantId/expandExistingBlockStorage', async (req, res) => {
  try {
    await expandExistingBlockVolume(req.params.tenantId);
    res.json({ 'message': 'successful' });
  }
  catch (err) {
    console.log("Failed to expande tenant: ", err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/tenants/:tenantId/expandToBlockStorage', async (req, res) => {
  try {
    const { sizeGb } = req.body || {};
    if (!sizeGb)
    {
      return res.status(400).json({ error: 'Missing "sizeGb" in request body' });
    }
    await expandToBlockStorage(req.params.tenantId, sizeGb);
    res.json({ 'message': 'successful' })
  } catch (err) {
    console.error('Failed to create tenant:', err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/tenants/:tenantId/removeBlockStorage', async (req, res) => {
  try {
    const { sizeGb } = req.body;
    if (!sizeGb)
    {
      return res.status(400).json({ error: 'Missing "sizeGb" in request body' });
    }
    await revertToLoopbackVolume(req.params.tenantId, sizeGb);
    res.json({ 'message': 'successful' })
  } catch (err) {
    console.error('Failed to create tenant:', err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/tenants/:tenantId/backup', async (req, res) => {
  const { tenantId } = req.params;
  const { backupName } = req.body;
  res.json({ started: true, tenantId, backupName });

  try {
    const result = backupTenantDatabase(tenantId, backupName);

    await fetch(`http://10.100.0.1:5000/confirm-backup/${backupName}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sizeBytes: result.sizeBytes,
        status: 'active',
      }),
    });
  } catch (err) {
    console.error(`Backup failed for tenant ${tenantId}:`, err);
    
    try {
      await fetch(`http://10.100.0.1:5000/confirm-backup/${backupName}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          status: 'failed',
          errorMessage: err.message,
        }),
      });
    } catch (notifyErr) {
      console.error(`Also failed to notify master of backup failure:`, notifyErr);
    }
  }
});

app.get('/tenants/:tenantId/mount-status', (req, res) => {
  const sizeRequested = parseFloat(req.query.sizeGb);
  if (isNaN(sizeRequested)) {
    return res.status(400).json({ error: 'Missing or invalid sizeGb query parameter' });
  }
  const dataDir = path.join(DATA_DIR, req.params.tenantId, 'postgres');

  try {
    const source = execSync(`findmnt -n -o SOURCE "${dataDir}"`, { encoding: 'utf8' }).trim();
    const isLoopBacked = source.startsWith('/dev/loop') || source.endsWith('.img');

    let sizeBytes;
    if (source.startsWith('/dev/')) {
      const lsblkOutput = execSync(`lsblk -bno SIZE "${source}"`, { encoding: 'utf8' }).trim();
      sizeBytes = parseInt(lsblkOutput.split('\n')[0], 10);
    } else {
      const statOutput = execSync(`stat -c%s "${source}"`, { encoding: 'utf8' }).trim();
      sizeBytes = parseInt(statOutput, 10);
    }

    const sizeGb = Math.round((sizeBytes / (1024 ** 3)) * 100) / 100;

    let isCommunal = isLoopBacked;
    if (!isLoopBacked && source.startsWith('/dev/')) {
      const baseDeviceMatch = source.match(/^\/dev\/(sd[a-z])/);
      const baseDevice = baseDeviceMatch ? baseDeviceMatch[1] : null;
      isCommunal = baseDevice === 'sda' || baseDevice === 'sdb';
    }

    let matches = false;
    if (!isCommunal && sizeRequested == sizeGb) {
      matches = true;
    }
    

    res.json({ mounted: true, device: source, sizeGb, isCommunal, matches });
  } catch (err) {
    console.error(`[mount-status] Error checking mount status:`, err.message);
    res.json({ mounted: false, device: null, sizeGb: null, isCommunal: null, matches: null });
  }
});

app.post('/tenants/restore', async (req, res) => {
  const { objectName } = req.body;
  if (!objectName) {
    return res.status(400).json({ error: 'Missing "objectName" in request body' });
  }

  try {
    const result = restoreTenantFromBackup(objectName);
    res.json(result);
  } catch (err) {
    console.error('Failed to restore tenant:', err);
    res.status(500).json({ error: err.message });
  }
});


app.post('/prepare-dedicated-storage', (req, res) => {
  const { tenantId, sizeGb } = req.body;
  try {
    let device = null;
    for (let i = 0; i < 20; i++) {
      device = findNewVolumeDevice(sizeGb);
      if (device) break;
      console.log(`Waiting for new block device to appear... (${i + 1}/20)`);
      execSync('sleep 2');
    }
    if (!device) {
      throw new Error(`Could not find a new block volume matching ${sizeGb}GB after waiting`);
    }

    const dataDir = path.join(DATA_DIR, tenantId, 'postgres');
    fs.mkdirSync(dataDir, { recursive: true });

    execSync(`sudo mkfs.ext4 -F "${device}"`);
    execSync(`sudo mount "${device}" "${dataDir}"`);
    execSync(`sudo chown -R 999:999 "${dataDir}"`);

    const uuid = execSync(`sudo blkid -s UUID -o value "${device}"`, { encoding: 'utf8' }).trim();
    execSync(`echo "UUID=${uuid} ${dataDir} ext4 defaults,nofail,_netdev 0 2" | sudo tee -a /etc/fstab`);

    res.json({ tenantId, device, prepared: true });
  } catch (err) {
    console.error('Failed to prepare dedicated storage:', err);
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, HOST, () => {
  console.log(`Agent listening on ${HOST}:${PORT}`);
});