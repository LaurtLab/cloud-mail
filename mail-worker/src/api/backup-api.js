import app from '../hono/hono';
import backupService from '../service/backup-service';

// Manual backup trigger. Guarded by jwt_secret (same pattern as /init/:secret).
// GET /api/backup/:secret       → run a backup now
// GET /api/backup/:secret/list  → list stored backups
app.get('/backup/:secret', async (c) => {
	if (c.req.param('secret') !== c.env.jwt_secret) {
		return c.text('❌ JWT secret mismatch');
	}
	const r = await backupService.backupToR2({ env: c.env });
	return c.json(r);
});

app.get('/backup/:secret/list', async (c) => {
	if (c.req.param('secret') !== c.env.jwt_secret) {
		return c.text('❌ JWT secret mismatch');
	}
	const r = await backupService.listBackups({ env: c.env });
	return c.json(r);
});
