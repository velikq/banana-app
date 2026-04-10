const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const SAFETY_BUFFER_MS = 60 * 60 * 1000;

/**
 * Persistent URL cache for Kie file uploads (shared across all models with vendor kie_ai).
 * Keys: vendor + api_key_hash + content_hash (MD5 of file bytes).
 */
class KieUploadCacheSqlite {
  /**
   * @param {string} dbPath - absolute path to .sqlite file
   */
  constructor(dbPath) {
    const dir = path.dirname(dbPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    this.db = new Database(dbPath);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS kie_upload_url (
        vendor TEXT NOT NULL,
        api_key_hash TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        url TEXT NOT NULL,
        expires_at_ms INTEGER NOT NULL,
        created_at_ms INTEGER NOT NULL,
        PRIMARY KEY (vendor, api_key_hash, content_hash)
      )
    `);
  }

  /**
   * @returns {{ url: string, expires_at_ms: number } | null}
   */
  get(vendor, apiKeyHash, contentHash) {
    const row = this.db
      .prepare(
        `SELECT url, expires_at_ms FROM kie_upload_url
         WHERE vendor = ? AND api_key_hash = ? AND content_hash = ?`
      )
      .get(vendor, apiKeyHash, contentHash);
    if (!row) return null;
    if (Date.now() >= row.expires_at_ms - SAFETY_BUFFER_MS) {
      this.delete(vendor, apiKeyHash, contentHash);
      return null;
    }
    return row;
  }

  set(vendor, apiKeyHash, contentHash, url, expiresAtMs) {
    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO kie_upload_url (vendor, api_key_hash, content_hash, url, expires_at_ms, created_at_ms)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(vendor, api_key_hash, content_hash) DO UPDATE SET
           url = excluded.url,
           expires_at_ms = excluded.expires_at_ms,
           created_at_ms = excluded.created_at_ms`
      )
      .run(vendor, apiKeyHash, contentHash, url, expiresAtMs, now);
  }

  delete(vendor, apiKeyHash, contentHash) {
    this.db
      .prepare(
        `DELETE FROM kie_upload_url
         WHERE vendor = ? AND api_key_hash = ? AND content_hash = ?`
      )
      .run(vendor, apiKeyHash, contentHash);
  }

  /** Remove rows that are past expiry (including buffer). */
  pruneExpired(nowMs = Date.now()) {
    this.db
      .prepare('DELETE FROM kie_upload_url WHERE expires_at_ms < ?')
      .run(nowMs - SAFETY_BUFFER_MS);
  }

  close() {
    this.db.close();
  }
}

module.exports = { KieUploadCacheSqlite, SAFETY_BUFFER_MS };
