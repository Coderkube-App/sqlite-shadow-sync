import fs from 'fs';
import path from 'path';
import { gunzipSync } from 'zlib';
import { SqliteShadowSync } from './dist/index.js'; // Imports our compiled package

// Configuration for local testing
const TEST_DIR = path.resolve('./test-sandbox');
const DB_PATH = path.join(TEST_DIR, 'test_app.db');
const BACKUP_DIR = path.join(TEST_DIR, 'backups');

// 16-byte valid SQLite 3 Header Signature
const SQLITE_HEADER = Buffer.concat([
  Buffer.from('SQLite format 3\0'),
  Buffer.alloc(100) // Dummy schema bytes
]);

async function runTest() {
  console.log('🧪 Starting sqlite-shadow-sync live verification tests...');

  // Setup sandbox directory
  if (fs.existsSync(TEST_DIR)) {
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  }
  fs.mkdirSync(TEST_DIR, { recursive: true });

  // 1. Create a mock valid SQLite database file
  fs.writeFileSync(DB_PATH, SQLITE_HEADER);
  console.log(`✓ Mock SQLite database created at: ${DB_PATH}`);

  // 2. Initialize SqliteShadowSync in watcher mode
  console.log('⚙️ Initializing SqliteShadowSync in Watch mode...');
  const shadow = new SqliteShadowSync({
    dbPath: DB_PATH,
    backupDir: BACKUP_DIR,
    watch: true,
    idleTimeoutMs: 1500, // Short timeout for rapid test
    compress: true,
    maxBackups: 2, // Low threshold to verify auto-rotation
  });

  let backupCount = 0;
  let backupPath = '';

  // Setup event listeners
  shadow.on('backupStart', () => {
    console.log('⏳ Passive File Watcher: Change detected, starting background shadow sync...');
  });

  // Return a promise that resolves when the backup finishes
  const waitForBackup = () => new Promise((resolve, reject) => {
    shadow.once('success', (savedPath) => {
      backupCount++;
      backupPath = savedPath;
      console.log(`✓ Backup successfully created!`);
      console.log(`📂 Saved backup location: ${savedPath}`);
      resolve(savedPath);
    });

    shadow.once('failure', (err) => {
      reject(err);
    });
  });

  // 3. Trigger Watcher: simulate database updates
  console.log('✍️ Simulating active application writes on SQLite database...');
  setTimeout(() => {
    fs.appendFileSync(DB_PATH, Buffer.from('INSERT INTO logs VALUES ("user_login", 17802);'));
    console.log('   (Database written, waiting for idleTimeoutMs quiet period...)');
  }, 500);

  // Wait for the first watcher backup to complete
  await waitForBackup();

  // 4. Verify Backup Contents
  console.log('🔎 Verifying backup format and header signatures...');
  if (!fs.existsSync(backupPath)) {
    throw new Error('Failure: Backup file does not exist on disk!');
  }

  // Read and decompress
  const compressedData = fs.readFileSync(backupPath);
  const decompressedData = gunzipSync(compressedData);
  const headerSignature = decompressedData.toString('utf-8', 0, 15);

  if (headerSignature === 'SQLite format 3') {
    console.log('✓ Verification: Backup database integrity signature is valid!');
  } else {
    throw new Error(`Failure: Invalid SQLite database signature: ${headerSignature}`);
  }

  // 5. Test rotation limits: trigger two more backup changes
  console.log('🔄 Testing backup rotation limit (maxBackups: 2)...');
  
  // Trigger backup 2
  const backupPromise2 = waitForBackup();
  fs.appendFileSync(DB_PATH, Buffer.from('INSERT INTO logs VALUES ("user_logout", 17803);'));
  await backupPromise2;

  // Trigger backup 3 (should trigger rotation)
  const backupPromise3 = waitForBackup();
  fs.appendFileSync(DB_PATH, Buffer.from('INSERT INTO logs VALUES ("page_view", 17804);'));
  await backupPromise3;

  // Check backups left in directory
  const files = fs.readdirSync(BACKUP_DIR).filter(f => f.endsWith('.db.gz'));
  console.log(`📂 Active backups remaining in backup directory: ${files.length} (Max: 2)`);
  if (files.length === 2) {
    console.log('✓ Verification: Database rotation works perfectly!');
  } else {
    throw new Error(`Failure: Expected 2 backups, found ${files.length}`);
  }

  // 6. Clean up watchers and directories
  console.log('🧹 Cleaning up test sandbox environment...');
  shadow.destroy();
  
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
  console.log('🎉 All sqlite-shadow-sync tests PASSED successfully!');
}

runTest().catch((err) => {
  console.error('❌ Test execution FAILED:', err);
  // Cleanup if possible
  try {
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  } catch {}
  process.exit(1);
});
