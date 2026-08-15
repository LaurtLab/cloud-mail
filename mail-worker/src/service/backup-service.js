// D1 automatic backup to R2.
// Dumps the whole D1 database to a single .sql file (schema + data), gzips it,
// and stores it in R2 under backups/. Runs from the daily scheduled cron and
// can be triggered manually via /api/backup/:secret. Retention keeps the most
// recent RETENTION_KEEP backups.
//
// Uses the raw D1 binding (env.db) rather than the drizzle orm wrapper so it is
// context-free (callable from scheduled()) and automatically covers every table
// via sqlite_master — no per-entity hardcoding, future tables are included.

const BACKUP_PREFIX = 'backups/';
const RETENTION_KEEP = 14; // keep the last 14 daily backups

// SQL-escape a single value into a literal for an INSERT statement.
function sqlLiteral(v) {
	if (v === null || v === undefined) return 'NULL';
	if (typeof v === 'number') return Number.isFinite(v) ? String(v) : 'NULL';
	if (typeof v === 'boolean') return v ? '1' : '0';
	if (typeof v === 'bigint') return v.toString();
	if (v instanceof ArrayBuffer || ArrayBuffer.isView(v)) {
		// BLOB → X'hex'
		const bytes = v instanceof ArrayBuffer ? new Uint8Array(v) : new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
		let hex = '';
		for (const b of bytes) hex += b.toString(16).padStart(2, '0');
		return `X'${hex}'`;
	}
	// string (and any other → stringify), escape single quotes
	const s = typeof v === 'string' ? v : JSON.stringify(v);
	return `'${s.replace(/'/g, "''")}'`;
}

// Build a full SQL dump (schema + data) of the D1 database.
async function dumpDatabase(env) {
	const tablesRes = await env.db
		.prepare(
			"SELECT name, sql FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' ORDER BY name"
		)
		.all();
	const tables = tablesRes.results || [];

	const parts = [];
	parts.push('PRAGMA foreign_keys=OFF;');
	parts.push('PRAGMA defer_foreign_keys=TRUE;');
	parts.push('BEGIN TRANSACTION;');

	let totalRows = 0;
	for (const tbl of tables) {
		const name = tbl.name;
		parts.push(`\n-- table: ${name}`);
		parts.push(`DROP TABLE IF EXISTS "${name}";`);
		if (tbl.sql) parts.push(`${tbl.sql};`);

		const rowsRes = await env.db.prepare(`SELECT * FROM "${name}"`).all();
		const rows = rowsRes.results || [];
		for (const row of rows) {
			const cols = Object.keys(row);
			const colList = cols.map((col) => `"${col}"`).join(', ');
			const valList = cols.map((col) => sqlLiteral(row[col])).join(', ');
			parts.push(`INSERT INTO "${name}" (${colList}) VALUES (${valList});`);
		}
		totalRows += rows.length;
	}

	parts.push('COMMIT;');
	parts.push('PRAGMA foreign_keys=ON;');
	return { sql: parts.join('\n'), tableCount: tables.length, rowCount: totalRows };
}

// gzip a string → Uint8Array (Workers CompressionStream).
async function gzip(text) {
	const stream = new Blob([text]).stream().pipeThrough(new CompressionStream('gzip'));
	const buf = await new Response(stream).arrayBuffer();
	return new Uint8Array(buf);
}

// Delete backups beyond the retention window (keep newest RETENTION_KEEP).
// Keys sort chronologically because the date is ISO (YYYY-MM-DD) in the name.
async function pruneOldBackups(env) {
	if (!env.r2) return { deleted: 0 };
	const listed = await env.r2.list({ prefix: BACKUP_PREFIX });
	const keys = (listed.objects || [])
		.map((o) => o.key)
		.filter((k) => k.endsWith('.sql.gz'))
		.sort(); // ascending → oldest first
	const excess = keys.length - RETENTION_KEEP;
	let deleted = 0;
	for (let i = 0; i < excess; i++) {
		await env.r2.delete(keys[i]);
		deleted++;
	}
	return { deleted };
}

const backupService = {
	// Run a full backup and store it in R2. Safe to call from cron or manually.
	async backupToR2({ env }) {
		if (!env.r2) {
			return { ok: false, skipped: true, reason: 'R2 binding (r2) not configured' };
		}
		const startedAt = new Date().toISOString();
		const date = startedAt.slice(0, 10); // YYYY-MM-DD
		const key = `${BACKUP_PREFIX}cloud-mail-${date}.sql.gz`;

		const { sql, tableCount, rowCount } = await dumpDatabase(env);
		const gz = await gzip(sql);

		await env.r2.put(key, gz, {
			httpMetadata: { contentType: 'application/gzip', contentEncoding: 'gzip' },
			customMetadata: { startedAt, tableCount: String(tableCount), rowCount: String(rowCount) },
		});

		const pruned = await pruneOldBackups(env);

		return {
			ok: true,
			key,
			bytes: gz.length,
			tableCount,
			rowCount,
			pruned: pruned.deleted,
			startedAt,
		};
	},

	// List stored backups (newest first).
	async listBackups({ env }) {
		if (!env.r2) return { ok: false, skipped: true, reason: 'R2 binding (r2) not configured' };
		const listed = await env.r2.list({ prefix: BACKUP_PREFIX });
		const items = (listed.objects || [])
			.filter((o) => o.key.endsWith('.sql.gz'))
			.map((o) => ({ key: o.key, size: o.size, uploaded: o.uploaded }))
			.sort((a, b) => (a.key < b.key ? 1 : -1)); // newest first
		return { ok: true, count: items.length, items };
	},
};

export default backupService;
