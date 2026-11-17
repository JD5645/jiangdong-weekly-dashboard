const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
require('./build.cjs');

const output = path.join(root, 'public');
fs.mkdirSync(output, { recursive: true });
const html = fs.readFileSync(path.join(root, '周期汇报看板.html'), 'utf8');
if (!html.includes('<head>')) throw new Error('Dashboard head is missing');
fs.writeFileSync(path.join(output, 'dashboard.html'), html.replace('<head>', '<head>\n  <meta name="jiangdong-cloud" content="github">'));

const reports = fs.readdirSync(path.join(root, 'src'))
  .filter(name => /^weekly-report-\d{4}-\d{2}-\d{2}\.json$/.test(name))
  .map(name => JSON.parse(fs.readFileSync(path.join(root, 'src', name), 'utf8')));
const assets = new Set(reports.flatMap(report => report.work.flatMap(item => (item.attachments || []).flatMap(asset => [asset.localPath, asset.thumbnailPath]))).filter(Boolean));
for (const asset of assets) {
  if (!/^assets\/\d{4}-\d{2}-\d{2}\/[A-Za-z0-9._-]+\.(?:png|jpe?g|webp|gif|bmp|avif|pdf|xlsx|xls|csv|tsv|docx|txt|md|mp4|webm)$/i.test(asset)) throw new Error(`Unsafe asset path: ${asset}`);
  const from = path.join(root, asset);
  const to = path.join(output, asset);
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.copyFileSync(from, to);
}
console.log(`Cloudflare client prepared: dashboard.html and ${assets.size} assets`);
