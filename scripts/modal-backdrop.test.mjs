import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { build } from 'esbuild';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const bundled = await build({
 stdin: { contents: "export * from './src/ui/modal-backdrop';export {Platform} from 'obsidian';", resolveDir: root },
 bundle: true, write: false, format: 'esm', platform: 'node',
 plugins: [{ name: 'platform', setup(b) {
  b.onResolve({ filter: /^obsidian$/ }, () => ({ path: 'platform', namespace: 'stub' }));
  b.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({ contents: 'export const Platform={isDesktopApp:true};' }));
 } }],
});
const { applyDesktopModalBackdrop, Platform } = await import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString('base64')}`);
function container() {
 const classes = new Set(['modal-container']);
 return { classes, addClass: c => classes.add(c), removeClass: c => classes.delete(c) };
}

test('desktop owns only the supplied container; detached cleanup and repeated cleanup are safe', () => {
 const a = container(), b = container();
 const closeA = applyDesktopModalBackdrop(a), closeB = applyDesktopModalBackdrop(b);
 assert.ok(a.classes.has('operon-focus-modal'));
 closeA(); assert.equal(a.classes.has('operon-focus-modal'), false); assert.ok(b.classes.has('operon-focus-modal'));
 const reopened = applyDesktopModalBackdrop(a);
 closeA(); assert.ok(a.classes.has('operon-focus-modal'), 'late old cleanup cannot affect reopened owner');
 reopened(); closeB(); assert.deepEqual([...a.classes], ['modal-container']); assert.deepEqual([...b.classes], ['modal-container']);
});
test('mobile is a no-op including close, with no DOM operations', () => {
 Platform.isDesktopApp = false;
 try { const close = applyDesktopModalBackdrop({}); close(); close(); } finally { Platform.isDesktopApp = true; }
});
for (const name of ['creator', 'finder', 'editor']) test(`${name} modal installs and releases the effect only at native open/close`, () => {
 const source = readFileSync(path.join(root, `src/ui/task-${name}-modal.ts`), 'utf8');
 assert.equal(source.match(/applyDesktopModalBackdrop\(this.containerEl\)/g)?.length, 1);
 const open = source.slice(source.indexOf('onOpen(): void'), source.indexOf('onClose(): void'));
 assert.match(open, /this.backdropCleanup\?\.\(\);\s*this.backdropCleanup = applyDesktopModalBackdrop\(this.containerEl\)/);
 assert.match(source, /onClose\(\): void \{\s*this.backdropCleanup\?\.\(\);\s*this.backdropCleanup = null;/);
});
test('non-modal Editor content never opts in', () => {
 const source = readFileSync(path.join(root, 'src/ui/task-editor-content.ts'), 'utf8');
 assert.doesNotMatch(source, /applyDesktopModalBackdrop|operon-focus-modal/);
});
