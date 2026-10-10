import { TaskCreationDraft } from './task-creation-draft';
import type { CreationDraftPropertyContext } from './task-creation-draft-properties';
import { resolvePipelineMinimalFileTaskTemplateStatus, type FileTaskTemplateOption } from './file-task-templates';
import type { Pipeline } from '../types/pipeline';
import {
	prepareCreationTemplate, type CreationTemplateClock, type CreationTemplateInputs,
	type CreationTemplateResult, type CreationTemplateFailure,
} from './task-creation-template';

export type CreationTemplateSessionSnapshot =
	| { status: 'empty' | 'loading' }
	| CreationTemplateResult;

/** Read-only loader boundary; the Creator adapter will supply its existing cached-read path. */
export type CreationTemplateReader = (path: string) => Promise<string>;

/** Owns one selection's cached source and clock. File/Inline mode is deliberately not a session input. */
export class CreationTemplateSession {
	private readonly properties: CreationDraftPropertyContext;
	private readonly pipelines: readonly Pipeline[];
	private selection: FileTaskTemplateOption | null = null;
	private clock: CreationTemplateClock | null = null;
	private inputs: CreationTemplateInputs | null = null;
	private content: string | null = null;
	private generation = 0;
	private state: CreationTemplateSessionSnapshot = { status: 'empty' };

	constructor(
		private readonly draft: TaskCreationDraft,
		properties: CreationDraftPropertyContext,
		pipelines: readonly Pipeline[],
		private readonly read: CreationTemplateReader,
	) {
		this.properties = structuredClone(properties);
		this.pipelines = structuredClone(pipelines);
	}

	async select(option: FileTaskTemplateOption | null, clock: CreationTemplateClock, inputs: CreationTemplateInputs): Promise<void> {
		this.selection = structuredClone(option);
		this.clock = structuredClone(clock);
		this.inputs = structuredClone(inputs);
		await this.load();
	}

	/** An explicit source refresh retains the current selection's frozen clock. */
	async refresh(): Promise<void> { await this.load(); }

	updateInputs(inputs: CreationTemplateInputs): void {
		this.inputs = structuredClone(inputs);
		if (this.content !== null && this.selection) this.prepare();
	}

	cancel(): void {
		this.generation++;
		this.selection = null;
		this.content = null;
		this.clock = null;
		this.inputs = null;
		this.draft.removeSource('template');
		this.state = { status: 'empty' };
	}

	selectedOption(): FileTaskTemplateOption | null { return structuredClone(this.selection); }

	snapshot(): CreationTemplateSessionSnapshot { return structuredClone(this.state); }

	private async load(): Promise<void> {
		const generation = ++this.generation;
		const option = this.selection;
		this.content = null;
		this.draft.removeSource('template');
		if (!option) { this.state = { status: 'empty' }; return; }
		this.state = { status: 'loading' };
		const token = this.draft.beginSource('template', option.id);
		if (option.kind === 'builtin-pipeline-minimal') {
			const status = resolvePipelineMinimalFileTaskTemplateStatus(option, this.pipelines);
			if (status === null) { this.fail(option.id, token.revision, 'invalid-pipeline'); return; }
			this.content = `---\nstatus: ${JSON.stringify(status)}\n---\n`;
		} else {
			try {
				const content = await this.read(option.path);
				if (generation !== this.generation) return;
				this.content = content;
			} catch {
				if (generation === this.generation) this.fail(option.id, token.revision, 'read-failed');
				return;
			}
		}
		this.prepare();
	}

	private prepare(): void {
		if (!this.selection || !this.clock || !this.inputs || this.content === null) return;
		const token = this.draft.beginSource('template', this.selection.id);
		const result = prepareCreationTemplate({
			content: this.content, sourceId: this.selection.id, revision: token.revision,
			clock: this.clock, inputs: this.inputs, properties: this.properties,
		});
		if (result.status === 'error') {
			this.fail(result.sourceId, result.revision, result.reason);
			return;
		}
		if (this.draft.applySource(token, result.fields)) this.state = result;
	}

	private fail(sourceId: string, revision: number, reason: CreationTemplateFailure['reason']): void {
		this.draft.removeSource('template');
		this.state = { status: 'error', sourceId, revision, reason };
	}
}
