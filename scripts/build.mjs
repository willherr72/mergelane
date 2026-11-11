import { build } from 'esbuild';
import sharp from 'sharp';
import { mkdir, cp, readFile, writeFile, access, rm, realpath } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = await realpath(fileURLToPath(new URL('..', import.meta.url)));
const output = path.resolve(root, 'dist');
if (path.dirname(output) !== root || path.basename(output) !== 'dist') throw new Error('Invalid build destination.');
await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });
await cp(path.join(root, 'public'), output, { recursive: true });
await build({
  absWorkingDir: root,
  entryPoints: { worker: 'src/background/worker.ts', options: 'src/ui/options.ts', popup: 'src/ui/popup.ts' },
  outdir: output, bundle: true, format: 'esm', platform: 'browser', target: 'chrome120',
  sourcemap: true, minify: false, legalComments: 'none', external: ['./assets/*'],
});
await build({ absWorkingDir: root, entryPoints: { 'token-import': 'src/content/token-import.ts' }, outdir: output, bundle: true, format: 'iife', platform: 'browser', target: 'chrome120', sourcemap: true, legalComments: 'none' });
const svg = await readFile(path.join(root, 'public/assets/mark.svg'));
for (const size of [16, 32, 48, 128]) await sharp(svg).resize(size, size).png().toFile(path.join(output, `assets/icon${size}.png`));
const manifest = JSON.parse(await readFile(path.join(output, 'manifest.json'), 'utf8'));
for (const file of [manifest.background.service_worker, manifest.action.default_popup, manifest.options_page, ...manifest.content_scripts.flatMap(script => script.js), 'options.js', 'options.css', 'popup.js', 'popup.css', ...Object.values(manifest.icons), 'assets/Roboto-400.ttf', 'assets/Roboto-500.ttf', 'assets/Roboto-700.ttf', 'assets/Roboto-OFL.txt']) await access(path.join(output, file));
await writeFile(path.join(output, 'BUILD.txt'), `MergeLane ${manifest.version}\nBuilt from local source. Load this directory as an unpacked extension.\n`);
console.log(`Built MergeLane ${manifest.version} → ${output}`);
