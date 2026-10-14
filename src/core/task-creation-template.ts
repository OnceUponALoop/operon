import { splitFrontmatterDocument } from './file-task-template-merge';
import { readFileTaskPropertyDocument } from './file-task-property-draft';
import { resolveCoreTemplateVariables } from './core-template-variables';
import { resolveOperonTemplateValue, type OperonTemplatePlaceholderContext } from './operon-id-placeholders';
import { CreationDraftProperties, type CreationDraftFieldInput, type CreationDraftPropertyContext } from './task-creation-draft-properties';

export type CreationTemplateInputs = Omit<OperonTemplatePlaceholderContext, 'date' | 'time' | 'datetime'> & { title: string };
export interface CreationTemplateClock {
	now: string;
	dateFormat?: string;
	timeFormat?: string;
}
export type CreationTemplateReason = 'templater' | 'identity' | 'system' | 'file-only' | 'unsupported' | 'automatic' | 'type-conflict' | 'unavailable';
export interface CreationTemplateDiagnostic {
	sourceName: string;
	reason: CreationTemplateReason;
	/** No encoding is authorized by an unverified type; the later writer must resolve it. */
	inline: 'skip' | 'deferred' | 'unverified';
}
export interface PreparedCreationTemplate {
	status: 'ready';
	sourceId: string;
	revision: number;
	rawContent: string;
 clock: CreationTemplateClock;
 inputs: CreationTemplateInputs;
	frontmatter: string | null;
	body: string;
	/** Common preview contributions, including read-only raw values; not a write request. */
	fields: CreationDraftFieldInput[];
	diagnostics: CreationTemplateDiagnostic[];
}
export interface CreationTemplateFailure {
	status: 'error';
	sourceId: string;
	revision: number;
	reason: 'invalid-yaml' | 'read-failed' | 'invalid-pipeline';
}
export type CreationTemplateResult = PreparedCreationTemplate | CreationTemplateFailure;

const FILE_ONLY = new Set(['aliases', 'cssclasses', 'position', 'title']);
const TOKEN = /<%[\s\S]*?%>|\{\{[^{}]*\}\}/g;
const ID = /\{\{operonId[0-9A-Za-z]?\}\}/;

/** Shield template expressions only; YAML structure and validation remain owned by the existing reader. */
function protectExpressions(frontmatter: string): { content: string; restore: (value: string) => string } {
	let prefix = 'OPERONCREATIONTOKEN';
	while (frontmatter.includes(prefix)) prefix += 'X';
	const expressions: string[] = [];
	const content = frontmatter.replace(TOKEN, expression => `${prefix}${expressions.push(expression) - 1}END`);
	if (content.includes('<%')) throw new Error('Unterminated template expression');
	const pattern = new RegExp(`${prefix}(\\d+)END`, 'g');
	return { content, restore: value => value.replace(pattern, (_match, index: string) => expressions[Number(index)]) };
}

function mapStrings(value: unknown, transform: (value: string) => string, seen = new Set<object>()): unknown {
	if (typeof value === 'string') return transform(value);
	if (value === null || typeof value !== 'object') return value;
	if (seen.has(value)) throw new Error('Cyclic YAML value');
	seen.add(value);
	try {
		if (Array.isArray(value)) return value.map(item => mapStrings(item, transform, seen));
		return Object.fromEntries(Object.entries(value).map(([key, item]) => [transform(key), mapStrings(item, transform, seen)]));
	} finally { seen.delete(value); }
}

function contains(value: unknown, predicate: (text: string) => boolean): boolean {
	if (typeof value === 'string') return predicate(value);
	if (Array.isArray(value)) return value.some(item => contains(item, predicate));
	return value !== null && typeof value === 'object' && Object.entries(value).some(([key, item]) => predicate(key) || contains(item, predicate));
}

/** Resolve original tokens once, never tokens introduced by the user's description or another replacement. */
export function resolveCreationTemplateValue(value: string, inputs: CreationTemplateInputs, clock: CreationTemplateClock): string {
	const context = { ...inputs, date: clock.now.slice(0, 10), time: clock.now.slice(11, 16), datetime: clock.now };
	return value.replace(/\{\{[^{}]*\}\}/g, token => {
		const operon = resolveOperonTemplateValue(token, context);
		return operon !== token ? operon : resolveCoreTemplateVariables(token, {
			...clock, title: inputs.title, date: context.date,
		});
	});
}

/** Pure YAML preparation. No IDs, clock reads, Templater execution, source writes or metadata inference. */
export function prepareCreationTemplate(input: {
	content: string;
	sourceId: string;
	revision: number;
	clock: CreationTemplateClock;
	inputs: CreationTemplateInputs;
	properties: CreationDraftPropertyContext;
}): CreationTemplateResult {
	const { content, sourceId, revision, clock, inputs, properties } = input;
	const split = splitFrontmatterDocument(content.replace(/^---(\r?\n)(?=---(?:\r?\n|$))/, '---$1$1'));
	const result: PreparedCreationTemplate = {
		status: 'ready', sourceId, revision, rawContent: content, clock: structuredClone(clock), inputs: structuredClone(inputs), ...split, fields: [], diagnostics: [],
	};
	const failure: CreationTemplateFailure = { status: 'error', sourceId, revision, reason: 'invalid-yaml' };
	if (split.frontmatter === null) return /^---(?:\r?\n|$)/.test(content) ? failure : result;
	if (!split.frontmatter.trim() || split.frontmatter.split(/\r?\n/).every(line => !line.trim() || line.trimStart().startsWith('#'))) return result;
	try {
		const protectedSource = protectExpressions(split.frontmatter);
		const parsed = readFileTaskPropertyDocument(`---\n${protectedSource.content}\n---\n`);
		if (!parsed) return failure;
		const catalog = new CreationDraftProperties(properties);
		const seen = new Set<string>();
		for (const encodedName of parsed.order) {
			const sourceName = protectedSource.restore(encodedName);
			// Dynamic names are not part of the property-value template contract.
			if (sourceName !== encodedName) return failure;
			const raw = mapStrings(parsed.frontmatter[encodedName], protectedSource.restore);
			const property = catalog.resolve(sourceName);
			const diagnose = (reason: CreationTemplateReason): void => {
				const inline = reason === 'identity' || reason === 'system' ? 'deferred'
					: reason === 'unsupported' || reason === 'templater' || reason === 'file-only' ? 'skip' : 'unverified';
				result.diagnostics.push({ sourceName, reason, inline });
			};
			if (seen.has(property.id)) diagnose('type-conflict');
			seen.add(property.id);
			if (property.merge === 'system') { diagnose('system'); continue; }
			if (contains(raw, text => text.includes('<%'))) { diagnose('templater'); continue; }
			if (contains(raw, text => ID.test(text))) { diagnose('identity'); continue; }
			if (FILE_ONLY.has(sourceName.toLowerCase())) { diagnose('file-only'); continue; }
			// Parse legacy list syntax before interpolation; an injected semicolon is one value, not a new member.
			const baseline = property.type === 'list' && property.interpretation !== 'native' ? catalog.read(property, raw).value ?? raw : raw;
			const value = mapStrings(baseline, text => resolveCreationTemplateValue(text, inputs, clock));
			const read = catalog.read(property, value);
			if (read.readOnlyReason) diagnose(read.readOnlyReason);
			result.fields.push({ sourceName, value, ...(property.merge === 'sequence' && Array.isArray(read.value) && Array.isArray(baseline) ? {
				memberKeys: stableMemberKeys(baseline),
			} : {}) });
		}
		return result;
	} catch { return failure; }
}

/** Source expressions remain stable as inputs change; inserting unrelated values cannot retarget an edit. */
function stableMemberKeys(values: readonly unknown[]): string[] {
	const occurrences = new Map<string, number>();
	return values.map(value => {
		const identity = typeof value === 'number' && Object.is(value, -0) ? '-0' : JSON.stringify(value);
		const occurrence = occurrences.get(identity) ?? 0;
		occurrences.set(identity, occurrence + 1);
		return JSON.stringify([identity, occurrence]);
	});
}

/** Materialize values without interpolating user text into YAML structure. */
export function resolveCreationTemplatePropertyValues(content: string, inputs: CreationTemplateInputs, clock: CreationTemplateClock): Record<string, unknown> {
 const frontmatter = splitFrontmatterDocument(content).frontmatter;
 if (!frontmatter?.trim()) return {};
 const protectedSource = protectExpressions(frontmatter);
 const parsed = readFileTaskPropertyDocument(`---\n${protectedSource.content}\n---\n`);
 if (!parsed) throw new Error('Invalid template YAML');
 return Object.fromEntries(parsed.order.map(name => [name, mapStrings(parsed.frontmatter[name], value =>
  resolveCreationTemplateValue(protectedSource.restore(value), inputs, clock))]));
}
