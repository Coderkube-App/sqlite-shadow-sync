import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import { gunzipSync } from 'zlib';
import { SqliteShadowSync } from './index';

const TEST_DIR = path.resolve('./src/__tests__sandbox');
const DB_PATH = path.join(TEST_DIR, 'test_app.db');
const BACKUP_DIR = path.join(TEST_DIR, 'backups');

// 16-byte valid SQLite 3 Header Signature
const SQLITE_HEADER = Buffer.concat([
  Buffer.from('SQLite format 3\0'),
  Buffer.alloc(100)
]);

describe('SqliteShadowSync', () => {
  beforeEach(() => {
    if (fs.existsSync(TEST_DIR)) {
      fs.rmSync(TEST_DIR, { recursive: true, force: true });
    }
    fs.mkdirSync(TEST_DIR, { recursive: true });
    // Write valid mock sqlite db file
    fs.writeFileSync(DB_PATH, SQLITE_HEADER);
  });

  afterEach(() => {
    if (fs.existsSync(TEST_DIR)) {
      fs.rmSync(TEST_DIR, { recursive: true, force: true });
    }
  });

  describe('Initialization', () => {
    it('should create backup directory if it does not exist', () => {
      const customBackupDir = path.join(TEST_DIR, 'new_backups');
      expect(fs.existsSync(customBackupDir)).toBe(false);

      const shadow = new SqliteShadowSync({
        dbPath: DB_PATH,
        backupDir: customBackupDir,
      });

      expect(fs.existsSync(customBackupDir)).toBe(true);
      shadow.destroy();
    });
  });

  describe('Passive Backups', () => {
    it('should successfully backup and compress a database file manually', async () => {
      const shadow = new SqliteShadowSync({
        dbPath: DB_PATH,
        backupDir: BACKUP_DIR,
        compress: true,
      });

      const backupPath = await shadow.backup();

      expect(fs.existsSync(backupPath)).toBe(true);
      expect(backupPath.endsWith('.db.gz')).toBe(true);

      // Verify header of decompressed backup
      const compressedData = fs.readFileSync(backupPath);
      const decompressedData = gunzipSync(compressedData);
      const headerSignature = decompressedData.toString('utf-8', 0, 15);
      expect(headerSignature).toBe('SQLite format 3');

      shadow.destroy();
    });

    it('should successfully backup without compression if compress is false', async () => {
      const shadow = new SqliteShadowSync({
        dbPath: DB_PATH,
        backupDir: BACKUP_DIR,
        compress: false,
      });

      const backupPath = await shadow.backup();

      expect(fs.existsSync(backupPath)).toBe(true);
      expect(backupPath.endsWith('.db')).toBe(true);

      const backupData = fs.readFileSync(backupPath);
      const headerSignature = backupData.toString('utf-8', 0, 15);
      expect(headerSignature).toBe('SQLite format 3');

      shadow.destroy();
    });

    it('should throw an error and emit failure if database file does not exist', async () => {
      const shadow = new SqliteShadowSync({
        dbPath: 'non_existent_db.db',
        backupDir: BACKUP_DIR,
      });

      let failureEmitted = false;
      shadow.on('failure', (err) => {
        expect(err.message).toContain('Database file not found at path');
        failureEmitted = true;
      });

      await expect(shadow.backup()).rejects.toThrow();
      expect(failureEmitted).toBe(true);

      shadow.destroy();
    });

    it('should throw an error and emit failure if database is corrupted (invalid header)', async () => {
      // Corrupt database
      fs.writeFileSync(DB_PATH, Buffer.from('INVALID_SQLITE_HEADER_DATA_123456'));

      const shadow = new SqliteShadowSync({
        dbPath: DB_PATH,
        backupDir: BACKUP_DIR,
      });

      let failureEmitted = false;
      shadow.on('failure', (err) => {
        expect(err.message).toBe('Database integrity check failed for shadow copy');
        failureEmitted = true;
      });

      await expect(shadow.backup()).rejects.toThrow('Database integrity check failed for shadow copy');
      expect(failureEmitted).toBe(true);

      shadow.destroy();
    });
  });

  describe('Active Backups', () => {
    it('should handle better-sqlite3 style database connection backup successfully', async () => {
      const shadow = new SqliteShadowSync({
        dbPath: DB_PATH,
        backupDir: BACKUP_DIR,
        compress: false,
      });

      // Mock better-sqlite3 connection
      const mockBetterSqliteDb = {
        backup: vi.fn().mockImplementation(async (targetPath: string) => {
          // Simulate native backup operation writing the file
          fs.writeFileSync(targetPath, SQLITE_HEADER);
        })
      };

      const backupPath = await shadow.backup({ dbConnection: mockBetterSqliteDb });

      expect(mockBetterSqliteDb.backup).toHaveBeenCalledWith(expect.any(String));
      expect(fs.existsSync(backupPath)).toBe(true);

      const backupData = fs.readFileSync(backupPath);
      const headerSignature = backupData.toString('utf-8', 0, 15);
      expect(headerSignature).toBe('SQLite format 3');

      shadow.destroy();
    });

    it('should handle node-sqlite3 style database connection backup (VACUUM INTO) successfully', async () => {
      const shadow = new SqliteShadowSync({
        dbPath: DB_PATH,
        backupDir: BACKUP_DIR,
        compress: false,
      });

      // Mock node-sqlite3 connection
      const mockSqlite3Db = {
        configure: vi.fn(),
        parallelize: vi.fn(),
        run: vi.fn().mockImplementation((query: string, params: any[], callback: (err: any) => void) => {
          expect(query).toBe('VACUUM INTO ?');
          const targetPath = params[0];
          // Simulate vacuum copy
          fs.writeFileSync(targetPath, SQLITE_HEADER);
          callback(null);
        })
      };

      const backupPath = await shadow.backup({ dbConnection: mockSqlite3Db });

      expect(mockSqlite3Db.run).toHaveBeenCalled();
      expect(fs.existsSync(backupPath)).toBe(true);

      const backupData = fs.readFileSync(backupPath);
      const headerSignature = backupData.toString('utf-8', 0, 15);
      expect(headerSignature).toBe('SQLite format 3');

      shadow.destroy();
    });

    it('should throw an error and emit failure if provided connection is unrecognized', async () => {
      const shadow = new SqliteShadowSync({
        dbPath: DB_PATH,
        backupDir: BACKUP_DIR,
      });

      const invalidDb = {
        someRandomMethod: () => {}
      };

      await expect(shadow.backup({ dbConnection: invalidDb })).rejects.toThrow(
        'Provided database connection does not support recognized SQLite backup APIs'
      );

      shadow.destroy();
    });
  });

  describe('Backup Rotation', () => {
    it('should rotate backups to respect maxBackups configuration', async () => {
      const shadow = new SqliteShadowSync({
        dbPath: DB_PATH,
        backupDir: BACKUP_DIR,
        compress: false,
        maxBackups: 2,
      });

      // First backup
      const backupPath1 = await shadow.backup();
      // Introduce slight wait to ensure distinguishable mtime values for sorting
      await new Promise(resolve => setTimeout(resolve, 50));

      // Second backup
      const backupPath2 = await shadow.backup();
      await new Promise(resolve => setTimeout(resolve, 50));

      // Third backup (should rotate the first one out)
      const backupPath3 = await shadow.backup();

      const files = fs.readdirSync(BACKUP_DIR).filter(f => f.startsWith('backup_') && f.endsWith('.db'));
      expect(files.length).toBe(2);

      // Verify that backupPath1 was deleted and backupPath2 & backupPath3 remain
      expect(fs.existsSync(backupPath1)).toBe(false);
      expect(fs.existsSync(backupPath2)).toBe(true);
      expect(fs.existsSync(backupPath3)).toBe(true);

      shadow.destroy();
    });

    it('should not rotate backups if maxBackups is set to 0 (unlimited)', async () => {
      const shadow = new SqliteShadowSync({
        dbPath: DB_PATH,
        backupDir: BACKUP_DIR,
        compress: false,
        maxBackups: 0,
      });

      await shadow.backup();
      await new Promise(resolve => setTimeout(resolve, 50));
      await shadow.backup();
      await new Promise(resolve => setTimeout(resolve, 50));
      await shadow.backup();

      const files = fs.readdirSync(BACKUP_DIR).filter(f => f.startsWith('backup_') && f.endsWith('.db'));
      expect(files.length).toBe(3);

      shadow.destroy();
    });
  });

  describe('Interval Backups', () => {
    it('should trigger backups automatically on the defined interval', async () => {
      const shadow = new SqliteShadowSync({
        dbPath: DB_PATH,
        backupDir: BACKUP_DIR,
        compress: false,
        intervalMs: 100,
      });

      let backupCount = 0;
      await new Promise<void>((resolve) => {
        shadow.on('success', () => {
          backupCount++;
          if (backupCount >= 2) {
            resolve();
          }
        });
      });

      expect(backupCount).toBeGreaterThanOrEqual(2);
      shadow.destroy();
    });
  });

  describe('File Watcher', () => {
    it('should trigger passive backups automatically when database file is modified', async () => {
      const shadow = new SqliteShadowSync({
        dbPath: DB_PATH,
        backupDir: BACKUP_DIR,
        compress: false,
        watch: true,
        idleTimeoutMs: 100,
      });

      const backupPromise = new Promise<string>((resolve) => {
        shadow.on('success', (savedPath) => {
          resolve(savedPath);
        });
      });

      // Write mock change to the database file
      fs.appendFileSync(DB_PATH, Buffer.from('INSERT INTO records VALUES (1, "new item");'));

      const savedBackup = await backupPromise;
      expect(fs.existsSync(savedBackup)).toBe(true);

      shadow.destroy();
    });
  });
});
