import { promises as fs } from 'node:fs';
import path from 'node:path';
import { Store, DATA_FILE, PUBLIC_DIR } from '../lib/store.mjs';
import { publishSnapshot } from '../lib/domain.mjs';

async function copyDir(from, to) {
  await fs.rm(to, { recursive: true, force: true });
  await fs.mkdir(to, { recursive: true });
  async function walk(dir, base = dir) {
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      const src = path.join(dir, entry.name);
      const rel = path.relative(base, src);
      const dst = path.join(to, rel);
      if (entry.isDirectory()) await walk(src, base);
      else await fs.copyFile(src, dst);
    }
  }
  await walk(from);
}

export async function buildStatic({ dataFile = DATA_FILE, outDir = PUBLIC_DIR, webDir = path.join(process.cwd(), 'web'), publishInitial = false, corruptCheck = false } = {}) {
  const store = new Store(dataFile);
  await store.load(true);
  let publication;
  try {
    publication = await store.mutation(async (db) => {
      let latest = Object.values(db.publications).filter((p) => p.status === 'published' && (p.snapshot || p.data)).sort((a, b) => b.version - a.version)[0];
      if (!latest && publishInitial) latest = await publishSnapshot(db, { actor: 'system', note: '初始静态发布' });
      if (!latest) throw Object.assign(new Error('没有已批准的公开数据版本；请先由编辑/审批者发布，再构建静态页。'), { status: 409 });
      return latest;
    });
  } catch (err) {
    return { ok: false, error: err.message, issues: err.issues || [] };
  }

  const snapshot = publication.snapshot || publication;
  // Re-validate the data that will be rendered. A previously approved snapshot
  // can become unsafe to rebuild if an out-of-band test/diagnostic edit breaks
  // references; in that case keep the previous dist untouched.
  const issues = snapshot.validationIssues?.length ? snapshot.validationIssues : [];
  if (corruptCheck) {
    const { validateForPublication } = await import('../lib/domain.mjs');
    const liveIssues = validateForPublication(store.db);
    if (liveIssues.some((i) => i.severity === 'error')) return { ok: false, error: '静态页构建失败：当前数据存在阻断性校验问题', issues: liveIssues };
  }
  if (issues.some((i) => i.severity === 'error')) return { ok: false, error: '存在阻断性校验问题', issues };

  const staging = `${outDir}.staging-${process.pid}-${Date.now()}`;
  try {
    await copyDir(webDir, staging);
    const target = path.join(staging, 'index.html');
    let html = await fs.readFile(target, 'utf8');
    if (!html.includes('__ARCHIVE_SNAPSHOT__')) throw new Error('index.html 缺少 __ARCHIVE_SNAPSHOT__ 注入点');
    html = html.replace('__ARCHIVE_SNAPSHOT__', JSON.stringify(snapshot).replace(/</g, '\\u003c'));
    await fs.writeFile(target, html, 'utf8');
    await fs.writeFile(path.join(staging, 'version.json'), JSON.stringify({
      id: snapshot.id, version: snapshot.version, publishedAt: snapshot.publishedAt, publishedBy: snapshot.publishedBy
    }, null, 2));
    await fs.rm(outDir, { recursive: true, force: true });
    await fs.rename(staging, outDir);
    return { ok: true, outDir, version: snapshot.version, id: snapshot.id, issues };
  } catch (err) {
    await fs.rm(staging, { recursive: true, force: true });
    return { ok: false, error: err.message, issues, version: snapshot.version };
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const publishInitial = process.argv.includes('--publish-initial');
  const result = await buildStatic({ publishInitial });
  if (!result.ok) {
    console.error(JSON.stringify(result, null, 2));
    process.exitCode = 1;
  } else {
    console.log(JSON.stringify(result, null, 2));
  }
}
