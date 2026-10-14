import { build } from 'esbuild';
import { runTasksConversionHoverTests } from './tasks-conversion-hover.test.mjs';
import { mkdtemp, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const temp = await mkdtemp(path.join(tmpdir(), 'operon-tasks-emoji-test-'));
try {
	const outfile = path.join(temp, 'tasks-emoji.test.mjs');
	await build({
		entryPoints: [path.join(root, 'scripts/tasks-emoji-conversion.test.ts')],
		outfile, bundle: true, format: 'esm', platform: 'node', target: ['node18'], logLevel: 'silent',
		alias: { obsidian: path.join(root, 'scripts/test-support/obsidian.ts') },
	});
	execFileSync(process.execPath, ['--test', outfile], { stdio: 'inherit' });
	await runTasksConversionHoverTests(root);
} finally {
	await rm(temp, { recursive: true, force: true });
}
