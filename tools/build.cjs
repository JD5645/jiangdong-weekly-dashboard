const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const vendor = path.join(root, 'vendor');
const licenses = path.join(root, 'licenses');
const source = path.join(root, 'src', 'dashboard-source.html');
const output = path.join(root, '周期汇报看板.html');
const html = fs.readFileSync(source, 'utf8').replace(/\r\n/g, '\n');
const reportFiles = fs.readdirSync(path.join(root, 'src')).filter(name => /^weekly-report-\d{4}-\d{2}-\d{2}\.json$/.test(name)).sort();
const reports = reportFiles.map(name => JSON.parse(fs.readFileSync(path.join(root, 'src', name), 'utf8')));
if (!reports.length) throw new Error('No weekly report JSON found in src');
const bundledReport = JSON.stringify(reports).replace(/</g, '\\u003c');
const filePaths = [...new Set(reports.flatMap(report => report.work.flatMap(item => item.attachments || [])).filter(asset => asset.localPath && !String(asset.type).startsWith('image/') && !String(asset.type).startsWith('video/')).map(asset => asset.localPath))];
const bundledFileAssets = Object.fromEntries(filePaths.map(relative => {
  if (!/^assets\/\d{4}-\d{2}-\d{2}\/[A-Za-z0-9._-]+\.(?:pdf|xlsx|xls|csv|tsv|docx|txt|md)$/i.test(relative)) throw new Error(`Invalid bundled file path: ${relative}`);
  return [relative, fs.readFileSync(path.join(root, relative)).toString('base64')];
}));

const assets = {
  pdfMain: fs.readFileSync(path.join(vendor, 'pdf.min.mjs'), 'utf8'),
  pdfWorker: fs.readFileSync(path.join(vendor, 'pdf.worker.min.mjs'), 'utf8'),
  ocrMain: fs.readFileSync(path.join(vendor, 'tesseract.min.js'), 'utf8'),
  ocrWorker: fs.readFileSync(path.join(vendor, 'tesseract-core-lstm.wasm.js'), 'utf8') + '\n' + fs.readFileSync(path.join(vendor, 'worker.min.js'), 'utf8'),
  ocrLang: fs.readFileSync(path.join(vendor, 'chi_sim.traineddata.gz')).toString('base64'),
  licenses: [
    'PDF.js\n' + fs.readFileSync(path.join(licenses, 'PDF.js-LICENSE.txt'), 'utf8'),
    'Tesseract.js\n' + fs.readFileSync(path.join(licenses, 'Tesseract.js-LICENSE.md'), 'utf8'),
    'Tesseract.js Core\n' + fs.readFileSync(path.join(licenses, 'Tesseract.js-Core-LICENSE.txt'), 'utf8')
  ].join('\n\n---\n\n')
};

for (const [name, value] of Object.entries(assets)) {
  if (/<\/script/i.test(value)) throw new Error(`${name} contains an unsafe script closing tag`);
}

const marker = '  <script>\n    (() => {';
const reportMarker = '  <script id="bundledWeeklyReport" type="application/json"></script>';
const pdfMarker = '  <script id="bundledFileAssets" type="application/json"></script>';
if (html.split(marker).length !== 2 || html.split(reportMarker).length !== 2 || html.split(pdfMarker).length !== 2 || html.includes('id="pdfJsModule"')) {
  throw new Error('Expected one unbundled dashboard script in src/dashboard-source.html');
}

const embedded = [
  `  <script id="pdfJsModule" type="application/x-pdfjs-module">${assets.pdfMain}</script>`,
  `  <script id="pdfJsWorker" type="application/x-pdfjs-worker">${assets.pdfWorker}</script>`,
  `  <script id="ocrWorker" type="application/x-ocr-worker">${assets.ocrWorker}</script>`,
  `  <script id="ocrLang" type="application/x-ocr-language">${assets.ocrLang}</script>`,
  `  <script id="thirdPartyLicenses" type="text/plain">${assets.licenses}</script>`,
  `  <script id="ocrMain" type="text/javascript">${assets.ocrMain}</script>`
].join('\n') + '\n';

// Replacement callback keeps dollar signs inside bundled libraries literal.
const built = html.replace(reportMarker, () => `  <script id="bundledWeeklyReport" type="application/json">${bundledReport}</script>`).replace(pdfMarker, () => `  <script id="bundledFileAssets" type="application/json">${JSON.stringify(bundledFileAssets)}</script>`).replace(marker, () => embedded + marker);
if ((built.match(/<!doctype html>/gi) || []).length !== 1) throw new Error('Build produced duplicate HTML documents');
fs.writeFileSync(output, built, 'utf8');
console.log(`已生成 ${output} (${Math.round(Buffer.byteLength(built) / 1048576 * 10) / 10} MB)`);
