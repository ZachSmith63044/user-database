import express from 'express';
import { createTenantDatabase, destroyTenantDatabase, expandToBlockStorage, revertToLoopbackVolume, expandExistingBlockVolume } from './provisioner.js';

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
    const { tier } = req.body;
    if (!tier) {
      return res.status(400).json({ error: 'Missing "tier" in request body' });
    }
    const result = await createTenantDatabase(tier);
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

app.listen(PORT, HOST, () => {
  console.log(`Agent listening on ${HOST}:${PORT}`);
});