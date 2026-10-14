import { markdownBodyStartLine } from './markdown-body';
import { iterateMarkdownFencedBlocks } from './markdown-fenced-lines';
import { measureMarkdownIndent } from './markdown-list-items';
import { collectMarkdownProtectedRanges, findMarkdownProtectedRangeAt } from './markdown-protected-ranges';

/** Conservative document admission, independent of the indexer's legacy scope. */
export function tasksConversionProtectedLines(content: string): Set<number> {
	const lines = content.split('\n');
	const protectedLines = new Set<number>();
	const body = markdownBodyStartLine(lines);
	for (let i = 0; i < (body ?? lines.length); i++) protectedLines.add(i);
	const masked = lines.map((line, index) => index < (body ?? lines.length) ? '' : line);
	const discoverFences = () => new Map([...iterateMarkdownFencedBlocks(masked.join('\n'))]
		.map(block => [block.contentStartLine - 1, block]));
	let fences = discoverFences(), refreshFences = false;
	let comment: 'html' | 'obsidian' | null = null;
	let rawHtml: HtmlBlock | null = null;
	const listIndents: number[] = [];
	for (let i = body ?? lines.length; i < lines.length; i++) {
		const line = lines[i].replace(/\r$/u, '');
		const fence = !comment && !rawHtml ? fences.get(i) : undefined;
		if (fence) {
			// The shared iterator's end may be the first line outside a list container.
			for (let number = i; number < fence.contentEndLine; number++) protectedLines.add(number);
			i = fence.contentEndLine - 1; continue;
		}
		let hidden = comment !== null || rawHtml !== null;
		let commentOffset = 0;
		if (rawHtml) {
			const advanced = advanceHtmlBlock(line, rawHtml);
			rawHtml = advanced.block; commentOffset = advanced.consumed;
		}
		if (!rawHtml) {
			const inlineRanges = collectMarkdownProtectedRanges(line);
			for (let offset = commentOffset; offset < line.length;) {
				if (comment) {
					const close = comment === 'html' ? '-->' : '%%';
					const end = line.indexOf(close, offset);
					if (end < 0) break;
					comment = null; offset = end + close.length; continue;
				}
				// Inline code and links are already protected by the line engine.
				const match = /<!--|%%|<(pre|script|style|textarea|div|table|section|article|details|ul|ol|blockquote)(?:\s|>|$)/iu.exec(line.slice(offset));
				if (!match) break;
				const protectedRange = findMarkdownProtectedRangeAt(inlineRanges, offset + match.index);
				if (protectedRange) { offset = protectedRange.to; continue; }
				hidden = true; offset += match.index + match[0].length;
				if (match[1]) {
					const tag = match[1].toLowerCase();
					const start = offset - match[0].length;
					const advanced = advanceHtmlBlock(line.slice(start), { tag, depth: 0, comment: false });
					rawHtml = advanced.block; offset = start + advanced.consumed;
					if (rawHtml) break;
					continue;
				}
				comment = match[0] === '<!--' ? 'html' : 'obsidian';
			}
		}
		if (hidden) {
			protectedLines.add(i); masked[i] = ''; listIndents.length = 0;
			refreshFences ||= line.includes('```') || line.includes('~~~');
			if (!comment && !rawHtml && refreshFences) { fences = discoverFences(); refreshFences = false; }
			continue;
		}
		if (!line.trim()) continue;
		const indent = measureMarkdownIndent(line);
		while (listIndents.length && indent < listIndents[listIndents.length - 1]) listIndents.pop();
		const base = listIndents[listIndents.length - 1] ?? 0;
		if (indent - base >= 4) { protectedLines.add(i); continue; }
		const list = /^\s*(?:[-+*]|\d{1,9}[.)])([ \t]+)(?=\S)/u.exec(line);
		if (list) listIndents.push(measureMarkdownIndent(line.slice(0, list[0].length).replace(/\S/gu, ' ')));
		else if (indent < base || !listIndents.length) listIndents.length = 0;
	}
	return protectedLines;
}

type HtmlTag = { name: string; closing: boolean; quote: string | null; last: string };
type HtmlBlock = { tag: string; depth: number; comment: boolean; pendingTag?: HtmlTag };
function advanceHtmlBlock(text: string, block: HtmlBlock): { block: HtmlBlock | null; consumed: number } {
	let offset = 0;
	while (offset < text.length) {
		if (block.pendingTag) {
			const pending = block.pendingTag;
			for (; offset < text.length; offset++) {
				const character = text[offset];
				if (pending.quote) { if (character === pending.quote) pending.quote = null; continue; }
				if (character === '"' || character === "'") { pending.quote = character; continue; }
				if (character === '>') {
					delete block.pendingTag; offset++;
					if (pending.name === block.tag) {
						if (pending.closing) block.depth--;
						else if (pending.last !== '/') block.depth++;
						if (block.depth === 0) return { block: null, consumed: offset };
					}
					break;
				}
				if (character.trim()) pending.last = character;
			}
			continue;
		}
		if (block.comment) {
			const close = text.indexOf('-->', offset);
			if (close < 0) break;
			block.comment = false; offset = close + 3; continue;
		}
		const start = text.indexOf('<', offset);
		if (start < 0) break;
		if (text.startsWith('<!--', start)) { block.comment = true; offset = start + 4; continue; }
		const name = /^<(\/?)([a-z][a-z0-9:-]*)(?=[\s/>]|$)/iu.exec(text.slice(start));
		if (!name) { offset = start + 1; continue; }
		block.pendingTag = { name: name[2].toLowerCase(), closing: !!name[1], quote: null, last: '' };
		offset = start + name[0].length;
	}
	return { block, consumed: text.length };
}

/** Canonical vault-relative paths only: never normalize an unsafe recovery target. */
export function isTasksConversionPath(path: string, folder = false): boolean {
	if (folder && path === '/') return true;
	return !!path && path === path.trim() && !path.includes('\\') && !/^[a-z]:/iu.test(path)
		&& !Array.from(path).some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)
		&& path.split('/').every(part => !!part && part !== '.' && part !== '..' && !part.startsWith('.'))
		&& (folder || path.endsWith('.md'));
}
