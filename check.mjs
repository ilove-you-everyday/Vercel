import { access, readFile, readdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const files = [];
async function walk(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) await walk(target);
    else if (entry.isFile() && /\.(?:js|mjs|cjs)$/.test(entry.name)) files.push(target);
  }
}
for (const directory of ['public', 'api', 'scripts']) await walk(path.join(root, directory));
for (const absolute of files) {
  const result = spawnSync(process.execPath, ['--check', absolute], { encoding: 'utf8' });
  if (result.status !== 0) {
    process.stderr.write(result.stderr || result.stdout || `Syntax check failed: ${path.relative(root, absolute)}\n`);
    process.exit(result.status || 1);
  }
}

const read = async relative => readFile(path.join(root, relative), 'utf8');
const parseJSON = async relative => JSON.parse(await read(relative));
const config = await parseJSON('vercel.json');
const pkg = await parseJSON('package.json');
const htmlPages = ['public/index.html', 'public/404.html'];
const html = await read('public/index.html');
const notFoundHtml = await read('public/404.html');
const app = await read('public/app.js');
const css = await read('public/styles.css');
const motionCss = await read('public/assets/clawd-motions.css');
const gitignore = await read('.gitignore');

if (config.outputDirectory !== 'public' || config.buildCommand !== 'npm run build') {
  throw new Error('Vercel output/build settings are missing or unexpected.');
}
if (!Array.isArray(config.functions) && typeof config.functions !== 'object') {
  throw new Error('Vercel Functions configuration is missing.');
}
if (!config.rewrites?.some(rule => rule.source === '/api/twikoo/(.*)' && rule.destination === '/api/twikoo')) {
  throw new Error('Twikoo nested API routes are not rewritten to /api/twikoo.');
}
if (!pkg.engines?.node || !pkg.dependencies?.mongodb || !pkg.dependencies?.['twikoo-vercel']) {
  throw new Error('Node engine or required server dependencies are missing.');
}
const serverTwikooVersion = String(pkg.dependencies['twikoo-vercel']).replace(/^[^\d]*/, '');
const twikooClientVersion = app.match(/twikoo@(\d+\.\d+\.\d+)\/dist\/twikoo\.min\.js/)?.[1];
if (!twikooClientVersion) throw new Error('A version-pinned Twikoo client CDN URL was not found.');
if (serverTwikooVersion && serverTwikooVersion !== twikooClientVersion) {
  throw new Error(`Twikoo client/server versions differ (${twikooClientVersion} vs ${serverTwikooVersion}).`);
}

const ids = [...html.matchAll(/\bid=["']([^"']+)["']/g)].map(match => match[1]);
const idCounts = new Map();
for (const id of ids) idCounts.set(id, (idCounts.get(id) || 0) + 1);
const duplicateIds = [...idCounts].filter(([, count]) => count > 1).map(([id]) => id);
if (duplicateIds.length) throw new Error(`Duplicate HTML IDs: ${duplicateIds.join(', ')}`);
const idSet = new Set(ids);
const missingIds = [...app.matchAll(/getElementById\(["']([^"']+)["']\)/g)].map(match => match[1]).filter(id => !idSet.has(id));
if (missingIds.length) throw new Error(`JavaScript references missing HTML IDs: ${[...new Set(missingIds)].join(', ')}`);

for (const pageFile of htmlPages) {
  const pageHtml = pageFile === 'public/index.html' ? html : notFoundHtml;
  for (const match of pageHtml.matchAll(/(?:src|href)=["'](\/[A-Za-z0-9_./-]+)["']/g)) {
    const reference = match[1];
    await access(path.join(root, 'public', reference.slice(1))).catch(() => {
      throw new Error(`Missing local frontend resource in ${pageFile}: ${reference}`);
    });
  }
  const pageIds = [...pageHtml.matchAll(/\bid=["']([^"']+)["']/g)].map(match => match[1]);
  if (new Set(pageIds).size !== pageIds.length) throw new Error(`Duplicate IDs in ${pageFile}.`);
}
for (const expected of ['/api/posts', '/api/twikoo']) {
  if (!app.includes(expected)) throw new Error(`Missing frontend API reference: ${expected}`);
}
if (app.includes('/.netlify/functions/')) throw new Error('Netlify-specific API path remains in the frontend.');
if (!app.includes('typeof payload.post.content!==\'string\'')) throw new Error('Article-load validation and fallback state are missing.');
if (!css.includes('.site-header{position:sticky;top:0;')) throw new Error('The hide/reveal navigation must remain sticky while scrolling.');
if (!html.includes('id="comment-section" aria-label="评论" hidden')) throw new Error('The comment area should stay hidden until article content loads.');
for (const marker of ['localStorage.setItem(STORAGE_THEME', 'function reshuffle()', 'function resetHomeIdle()', 'function updateTopButton()', 'function markdownToSafeHTML(', 'function openArticle(']) {
  if (!app.includes(marker)) throw new Error(`Missing expected core interaction: ${marker}`);
}
if (!app.includes('onCommentLoaded:()=>{if(callId===twikooLoadId)finishCommentSubmit()}')) throw new Error('Comment success animation is not tied to Twikoo successful-load callback.');
if (!css.includes('prefers-reduced-motion:reduce') || !motionCss.includes('prefers-reduced-motion: reduce')) {
  throw new Error('Reduced-motion support is missing.');
}
for (const [file, text] of [['styles.css', css], ['clawd-motions.css', motionCss]]) {
  if ((text.match(/{/g) || []).length !== (text.match(/}/g) || []).length) throw new Error(`Unbalanced CSS braces in ${file}.`);
}
for (const required of ['.env', '.vercel', 'node_modules']) {
  if (!gitignore.split(/\r?\n/).some(line => line.trim().replace(/\/$/, '') === required)) throw new Error(`.gitignore should exclude ${required}.`);
}
for (const testFile of ['scripts/test-api.cjs', 'scripts/test-twikoo-adapter.cjs']) {
  const result = spawnSync(process.execPath, [path.join(root, testFile)], { encoding: 'utf8', env: process.env });
  if (result.status !== 0) {
    process.stderr.write(result.stderr || result.stdout || `Test failed: ${testFile}\n`);
    process.exit(result.status || 1);
  }
  process.stdout.write(result.stdout);
}
console.log(`HALCYON checks passed: ${files.length} JavaScript/module files, Vercel/Twikoo routing and version locks, HTML IDs/assets, sticky navigation, article fallback, reduced-motion rules, secret exclusions, and API unit tests.`);
