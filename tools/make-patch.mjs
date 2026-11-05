// Builds the small "patch" zip that ships next to the full installer.
//
//   node tools/make-patch.mjs [--out <path>]
//
// Every runtime file this project owns goes into one zip together with
// update-manifest.json (path + sha256 for each file). The app downloads the zip,
// verifies each hash, and only then replaces files whose content actually
// changed. node_modules / the bundled Node + Codex runtime are never included:
// when dependencies change the patch declares a different dependency
// fingerprint and the app asks the user for the full installer instead.
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { depsFingerprint } from '../update.mjs';

const execFileAsync = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const SKIP_DIRS = new Set(['node_modules', 'runtime', 'tests', 'docs', 'tools', '.git', '.github', '.workbuddy', '_update-backup', 'images', 'stage']);
const SKIP_FILES = new Set([
  'Build Branded Installer.ps1',
  'Build Update Patch.cmd',
  'Deploy to Installed.ps1',
  'Deploy to Installed.cmd',
  'Install Branded.cmd',
  'update-state.json',
  'update-manifest.json',
  '.gitignore',
  '.gitattributes',
]);
const KEEP_EXTENSIONS = new Set(['.mjs', '.html', '.ps1', '.cmd', '.vbs', '.json', '.ico']);

function keep(fileName) {
  if (SKIP_FILES.has(fileName)) return false;
  if (fileName.startsWith('.')) return false;
  return KEEP_EXTENSIONS.has(path.extname(fileName).toLowerCase());
}

async function collect(dir, prefix = '', out = []) {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      await collect(path.join(dir, entry.name), relative, out);
    } else if (entry.isFile() && keep(entry.name)) {
      out.push(relative);
    }
  }
  return out;
}

async function main() {
  const args = process.argv.slice(2);
  const outIndex = args.indexOf('--out');
  const packageJson = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'));
  const version = String(packageJson.version || '').trim();
  if (!version) throw new Error('package.json 没有 version');

  const output = path.resolve(outIndex >= 0 && args[outIndex + 1]
    ? args[outIndex + 1]
    : path.join(root, '..', `CodexCompanion-Patch-v${version}.zip`));

  const files = (await collect(root)).sort();
  if (!files.length) throw new Error('没有找到可打包的文件');
  if (!files.includes('server.mjs')) throw new Error('打包清单里缺少 server.mjs，检查 KEEP_EXTENSIONS');

  const stage = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-patch-'));
  const manifestFiles = [];
  for (const relative of files) {
    const source = path.join(root, relative);
    const target = path.join(stage, relative);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.copyFile(source, target);
    const bytes = await fs.readFile(source);
    manifestFiles.push({ path: relative, sha256: createHash('sha256').update(bytes).digest('hex'), size: bytes.length });
  }

  const manifest = {
    format: 1,
    version,
    depsFingerprint: depsFingerprint(packageJson),
    files: manifestFiles,
  };
  await fs.writeFile(path.join(stage, 'update-manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');

  // Compress-Archive ships with Windows PowerShell 5.1; keeping the zip creation
  // there avoids adding a dependency to a project that ships without node_modules.
  await fs.rm(output, { force: true });
  await execFileAsync('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command',
    `Compress-Archive -Path '${path.join(stage, '*').replace(/'/g, "''")}' -DestinationPath '${output.replace(/'/g, "''")}' -CompressionLevel Optimal`,
  ], { timeout: 180000, windowsHide: true });

  const zipBytes = await fs.readFile(output);
  const digest = createHash('sha256').update(zipBytes).digest('hex').toUpperCase();
  const rawSize = manifestFiles.reduce((sum, file) => sum + file.size, 0);
  console.log(`patch  : ${output}`);
  console.log(`version: ${version}`);
  console.log(`files  : ${manifestFiles.length} (${Math.round(rawSize / 1024)} KB raw)`);
  console.log(`size   : ${Math.round(zipBytes.length / 1024)} KB`);
  console.log(`sha256 : ${digest}`);
  await fs.rm(stage, { recursive: true, force: true });
}

main().catch(error => {
  console.error('构建补丁失败：', error.message);
  process.exit(1);
});
