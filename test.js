import { createTenantDatabase } from './provisioner.js';

createTenantDatabase({
  shared_buffers_mb: 55,
  work_mem_mb: 2,
  effective_cache_size_mb: 165,
  max_sql_connections: 7,
  max_client_connections: 100,
  pool_size: 5,
  hostPort: 3004,
  postgres_ram_mb: 170,
  pgbouncer_ram_mb: 15,
  postgrest_ram_mb: 35,
  pgbouncer_port: 6433
}).then(result => {
  console.log('Created:', result);
}).catch(err => {
  console.error('Failed:', err);
});


// docker exec -it tenant-d742f920-0a24-45c3-a94e-4bf089d38c11-postgres psql -U testuser -d db_d742f9200a2445c3a94e4bf089d38c11 -c "CREATE TABLE items (id serial primary key, name text, quantity int);"

// docker exec -it tenant-d742f920-0a24-45c3-a94e-4bf089d38c11-postgres psql -U testuser -d db_d742f9200a2445c3a94e4bf089d38c11 -c "\dy"

// ssh -i "C:\Users\zakha\Downloads\ssh-key-2026-07-20.key" ubuntu@141.147.99.94