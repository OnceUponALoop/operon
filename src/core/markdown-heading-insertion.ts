import { markdownBodyStartLine } from './markdown-body';
import { iterateMarkdownFencedBlocks } from './markdown-fenced-lines';

export interface InlineHeadingKeywordInsertionResult {
	content: string;
	insertedLineNumber: number;
	headingLineNumber: number;
	headingWasCreated: boolean;
}

export interface InlineExactHeadingInsertionResult {
	content: string;
	insertedLineNumber: number;
}

export const MARKDOWN_HEADING_RE = /^(#{1,6})\s+(.+?)\s*#*\s*$/;

export class UnsafeMarkdownHeadingInsertionError extends Error {}

export function normalizeMarkdownHeadingKeyword(raw: string, fallback: string): string {
	const trimmed = raw.trim();
	const withoutHeadingMarker = trimmed.replace(/^#{1,6}\s+/, '').trim();
	return withoutHeadingMarker || fallback.trim();
}

export function insertInlineTaskUnderFirstHeadingKeyword(
	content: string,
	keyword: string,
	taskLine: string,
	headingLevel = 2,
): InlineHeadingKeywordInsertionResult {
	const safeKeyword = keyword.trim();
	const headingDepth = Math.max(1, Math.min(6, Math.floor(headingLevel)));
	return insertUnderHeading(content, taskLine, `${'#'.repeat(headingDepth)} ${safeKeyword}`,
		heading => !!heading.match(MARKDOWN_HEADING_RE)?.[2].trim().toLowerCase().includes(safeKeyword.toLowerCase()));
}

export function insertInlineTaskUnderHeading(
	content: string,
	heading: string,
	taskLine: string,
): InlineExactHeadingInsertionResult {
	const result = insertUnderHeading(content, taskLine, heading.trim(), candidate => candidate === heading.trim());
	return { content: result.content, insertedLineNumber: result.insertedLineNumber };
}

function insertUnderHeading(
	content: string,
	taskLine: string,
	newHeading: string,
	matches: (heading: string) => boolean,
): InlineHeadingKeywordInsertionResult {
	const newline = content.includes('\r\n') ? '\r\n' : '\n';
	const lines = content.length ? content.split(/\r?\n/u) : [];
	const bodyStart = markdownBodyStartLine(lines);
	if (bodyStart === null) throw new UnsafeMarkdownHeadingInsertionError('Cannot insert a task into unclosed frontmatter.');
	const body = lines.slice(bodyStart);
	const protectedLines = new Set<number>();
	let canAppend = true;
	for (const block of iterateMarkdownFencedBlocks(body.join('\n'))) {
		for (let index = block.contentStartLine - 1; index < block.contentEndLine; index++) protectedLines.add(bodyStart + index);
		if (block.contentEndLine >= body.length) canAppend = false;
	}
	for (let index = bodyStart; index < lines.length; index++) {
		if (protectedLines.has(index) || !/^ {0,3}#{1,6}\s+/u.test(lines[index]) || !matches(lines[index].trim())) continue;
		lines.splice(index + 1, 0, taskLine);
		return { content: lines.join(newline), insertedLineNumber: index + 1, headingLineNumber: index, headingWasCreated: false };
	}
	if (!canAppend) throw new UnsafeMarkdownHeadingInsertionError('Cannot append a task inside an unclosed code block.');
	while (lines.length > 0 && !lines[lines.length - 1].trim()) lines.pop();
	if (lines.length > 0) lines.push('');
	lines.push(newHeading, taskLine);
	return { content: lines.join(newline), insertedLineNumber: lines.length - 1, headingLineNumber: lines.length - 2, headingWasCreated: true };
}
