const fs = require('node:fs');
const path = require('node:path');
const sharp = require('sharp');

const root = path.resolve(__dirname, '..');
require('./build.cjs');

const output = path.join(root, 'public');
fs.mkdirSync(output, { recursive: true });
const html = fs.readFileSync(path.join(root, '周期汇报看板.html'), 'utf8');
if (!html.includes('<head>')) throw new Error('Dashboard head is missing');
const heavyIds = ['pdfJsModule', 'pdfJsWorker', 'ocrWorker', 'ocrLang', 'ocrMain'];
let cloudHtml = html.replace('<head>', '<head>\n  <meta name="jiangdong-cloud" content="github">');
for (const id of heavyIds) {
  const pattern = new RegExp(`  <script id="${id}"[^>]*>[\\s\\S]*?<\\/script>\\n`);
  if (!pattern.test(cloudHtml)) throw new Error(`Bundled ${id} is missing`);
  cloudHtml = cloudHtml.replace(pattern, '');
}
const filesPattern = /<script id="bundledFileAssets" type="application\/json">[\s\S]*?<\/script>/;
if (!filesPattern.test(cloudHtml)) throw new Error('Bundled files are missing');
cloudHtml = cloudHtml.replace(filesPattern, '<script id="bundledFileAssets" type="application/json">{}</script>');
fs.writeFileSync(path.join(output, 'dashboard.html'), cloudHtml);

const cloudVendor = path.join(output, 'vendor');
fs.mkdirSync(cloudVendor, { recursive: true });
for (const name of ['pdf.min.mjs', 'pdf.worker.min.mjs', 'tesseract.min.js', 'chi_sim.traineddata.gz']) {
  fs.copyFileSync(path.join(root, 'vendor', name), path.join(cloudVendor, name));
}
fs.writeFileSync(path.join(cloudVendor, 'ocr-worker.js'),
  fs.readFileSync(path.join(root, 'vendor', 'tesseract-core-lstm.wasm.js')) + '\n' +
  fs.readFileSync(path.join(root, 'vendor', 'worker.min.js')));

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
const imageAssets = [...assets].filter(asset => /^assets\/\d{4}-\d{2}-\d{2}\/[A-Za-z0-9._-]+\.(?:png|jpe?g|webp|gif|bmp|avif)$/i.test(asset));
Promise.all(imageAssets.map(async asset => {
  const [, date, name] = /^assets\/(\d{4}-\d{2}-\d{2})\/(.+)$/.exec(asset);
  const target = path.join(output, 'thumbs', date, `${name}.webp`);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  await sharp(path.join(root, asset), { animated: false }).resize({ width: 360, height: 360, fit: 'inside', withoutEnlargement: true }).webp({ quality: 72 }).toFile(target);
})).then(() => {
  console.log(`Cloudflare client prepared: dashboard.html (${Math.round(Buffer.byteLength(cloudHtml) / 1024)} KB), lazy vendor files, ${assets.size} assets and ${imageAssets.length} thumbnails`);
}).catch(error => { console.error(error); process.exitCode = 1; });
