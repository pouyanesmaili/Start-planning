const fs = require('fs');
const path = require('path');
const root = __dirname;
const target = path.join(root, 'www');
const files = [
  'index.html', 'planeers.css', 'planners.js', 'manifest.json', 'sw.js',
  'icon.svg', 'icon-192.png', 'icon-512.png', 'apple-touch-icon.png'
];
fs.mkdirSync(target, { recursive: true });
for (const file of files) fs.copyFileSync(path.join(root, file), path.join(target, file));
console.log(`Copied ${files.length} web files into www/`);
