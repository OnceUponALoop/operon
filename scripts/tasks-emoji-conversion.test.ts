import assert from 'node:assert/strict';
import { test } from 'node:test';
import { convertTasksEmojiLineToOperon } from '../src/core/tasks-emoji-to-operon';
import { planTasksEmojiBatchConversion, type TasksEmojiConversionInput } from '../src/core/tasks-emoji-batch';
import { applyTasksEmojiConversionToParsedTask } from '../src/core/tasks-emoji-application';
import { parseTaskLine } from '../src/core/parser';
import { serializeTask } from '../src/core/serializer';
import { validateDependencyEdge, validateDependencyEdgeSet } from '../src/core/dependency-graph';
import { calculateNextRepeatDate, parseRepeatRule } from '../src/core/repeat-rule';
import { fixture } from './tasks-conversion-service.test';
import './tasks-conversion-ui.test';

function convert(line: string) {
	const result = convertTasksEmojiLineToOperon(line);
	assert.equal(result.kind, 'converted');
	if (result.kind !== 'converted') throw new Error('Expected conversion');
	return result;
}
function input(sourceKey: string, line: string, operonId: string): TasksEmojiConversionInput {
	return { sourceKey, line, operonId };
}
function fields(result: ReturnType<typeof planTasksEmojiBatchConversion>, sourceKey: string) {
	const item = result.items.find(item => item.sourceKey === sourceKey);
	assert.ok(item);
	assert.equal(item.conversion.kind, 'converted');
	if (item.conversion.kind !== 'converted') throw new Error('Expected conversion');
	return item.conversion.mappedFields;
}

for (const line of ['- [ ] Plain', '- [>] Custom status', '- [ ] Code `🆔 secret`', '- [ ] Link [🆔 secret](target)', '- [ ] Code `🔁 every day`']) {
	test(`excludes non-Tasks metadata: ${line}`, () => {
		assert.equal(convertTasksEmojiLineToOperon(line).kind, 'not_tasks_emoji');
	});
}
test('preserves protected text adjacent to metadata and does not extract code IDs', () => {
	const result = convert('- [ ] Task 🆔 visible `🆔 hidden id:: code` 📅 2026-10-08');
	assert.equal(result.description, 'Task `🆔 hidden id:: code`');
	assert.deepEqual(result.dependencyMetadata, [{ kind: 'id', raw: '🆔 visible', ids: ['visible'] }]);
});
test('existing and hybrid Operon lines remain excluded', () => {
	assert.equal(convertTasksEmojiLineToOperon('- [ ] Task {{operonId:: abc1234}}').kind, 'already_operon');
	assert.equal(convertTasksEmojiLineToOperon('- [ ] Task {{operonId:: abc1234}} 🆔 abc').kind, 'hybrid_unsupported');
});
test('standalone conversion retains ID and dependencies until command integration', () => {
	const result = convert('- [ ] Task 🆔 Task_1 ⛔ A-1, B_2, A-1');
	assert.deepEqual(result.dependencyMetadata?.map(fragment => fragment.ids), [['Task_1'], ['A-1', 'B_2']]);
	assert.deepEqual(result.leftovers, ['🆔 Task_1', '⛔ A-1, B_2, A-1']);
	assert.equal(result.mappedFields.blockedBy, undefined);
});
for (const action of ['keep', 'delete', 'unknown']) {
	test(`preserves on-completion ${action} without applying behavior`, () => {
		const result = convert(`- [ ] Task 🔁 every day 🏁 ${action} 📅 2026-10-08`);
		assert.equal(result.description, 'Task');
		assert.equal(result.mappedFields.repeat, 'mode=schedule|freq=day|interval=1');
		assert.deepEqual(result.leftovers, [`🏁 ${action} (on-completion action is not supported)`]);
	});
}

test('resolves forward/backward cross-file references and reciprocal fields without mutating inputs', () => {
	const inputs = [
		input('B.md:2', '- [ ] B ⛔ A, C', 'bbbbbbb'),
		input('A.md:0', '- [ ] A 🆔 A', 'aaaaaaa'),
		input('C.md:5', '- [x] C 🆔 C', 'ccccccc'),
	];
	const snapshot = JSON.stringify(inputs);
	const result = planTasksEmojiBatchConversion(inputs);
	assert.deepEqual(fields(result, 'B.md:2'), { blockedBy: 'aaaaaaa; ccccccc' });
	assert.deepEqual(fields(result, 'A.md:0'), { blocking: 'bbbbbbb' });
	assert.deepEqual(fields(result, 'C.md:5'), { blocking: 'bbbbbbb' });
	assert.deepEqual(result.idMappings, [{ tasksId: 'A', operonId: 'aaaaaaa' }, { tasksId: 'C', operonId: 'ccccccc' }]);
	assert.ok(result.items.every(item => item.conversion.kind === 'converted' && !item.conversion.leftovers.length));
	assert.equal(JSON.stringify(inputs), snapshot);
	const reversed = planTasksEmojiBatchConversion([...inputs].reverse());
	for (const item of inputs) assert.deepEqual(fields(reversed, item.sourceKey), fields(result, item.sourceKey));
});
test('keeps valid dependencies alongside unavailable references', () => {
	const result = planTasksEmojiBatchConversion([
		input('A', '- [ ] A 🆔 A', 'aaaaaaa'),
		input('B', '- [ ] B ⛔ A, outside', 'bbbbbbb'),
	]);
	assert.equal(fields(result, 'B').blockedBy, 'aaaaaaa');
	assert.equal(result.items[1].diagnostics[0].code, 'unresolved-dependency');
	assert.equal(result.items[1].diagnostics[0].raw, '⛔ A, outside');
});
for (const extra of ['🆔 dup', '🆔 other 🆔 dup', '🆔 dup 🆔 dup']) {
	test(`does not choose ambiguous IDs: ${extra}`, () => {
		const result = planTasksEmojiBatchConversion([
			input('A', '- [ ] A 🆔 dup', 'aaaaaaa'),
			input('B', `- [ ] B ${extra}`, 'bbbbbbb'),
			input('C', '- [ ] C ⛔ dup', 'ccccccc'),
		]);
		assert.equal(fields(result, 'C').blockedBy, undefined);
		assert.equal(result.idMappings.length, 0);
		assert.equal(result.items[2].diagnostics[0].code, 'duplicate-id');
	});
}
for (const raw of ['🆔', '🆔 A B', '🆔 a.b', '⛔', '⛔ A,,B', '⛔ A,', '⛔ A B']) {
	test(`preserves invalid complete expressions: ${raw}`, () => {
		const result = planTasksEmojiBatchConversion([input('A', `- [ ] Task ${raw}`, 'aaaaaaa')]);
		assert.equal(result.items[0].diagnostics.length, 1);
		assert.equal(result.items[0].diagnostics[0].raw, raw);
		assert.equal(result.idMappings.length, 0);
		assert.deepEqual(fields(result, 'A'), {});
	});
}
test('case-sensitive IDs and repeated valid dependency fragments', () => {
	const result = planTasksEmojiBatchConversion([
		input('A', '- [ ] A 🆔 A', 'aaaaaaa'),
		input('B', '- [ ] B ⛔ A, A ⛔ A ⛔ a', 'bbbbbbb'),
	]);
	assert.equal(fields(result, 'A').blocking, 'bbbbbbb');
	assert.equal(fields(result, 'B').blockedBy, 'aaaaaaa');
	assert.equal(result.items[1].diagnostics.length, 1);
});
test('rejects self dependencies', () => {
	const result = planTasksEmojiBatchConversion([input('A', '- [ ] A 🆔 A ⛔ A', 'aaaaaaa')]);
	assert.equal(fields(result, 'A').blockedBy, undefined);
	assert.equal(result.items[0].diagnostics[0].code, 'self');
});
test('removes all cyclic edges simultaneously but preserves independent valid edges', () => {
	const inputs = [
		input('A', '- [ ] A 🆔 A ⛔ C', 'aaaaaaa'),
		input('B', '- [ ] B 🆔 B ⛔ A', 'bbbbbbb'),
		input('C', '- [ ] C 🆔 C ⛔ B', 'ccccccc'),
		input('D', '- [ ] D ⛔ A', 'ddddddd'),
	];
	const result = planTasksEmojiBatchConversion(inputs);
	assert.deepEqual(fields(result, 'A'), { blocking: 'ddddddd' });
	assert.deepEqual(fields(result, 'B'), {});
	assert.deepEqual(fields(result, 'C'), {});
	assert.deepEqual(fields(result, 'D'), { blockedBy: 'aaaaaaa' });
	assert.deepEqual(result.items.map(item => item.diagnostics.map(issue => issue.code)), [['cycle'], ['cycle'], ['cycle'], []]);
	const reversed = planTasksEmojiBatchConversion([...inputs].reverse());
	for (const item of inputs) assert.deepEqual(fields(reversed, item.sourceKey), fields(result, item.sourceKey));
});
test('unrelated plain, protected, existing and hybrid inputs do not supply ID targets', () => {
	const result = planTasksEmojiBatchConversion([
		input('plain', '- [>] Plain', 'aaaaaaa'),
		input('code', '- [ ] `🆔 A`', 'bbbbbbb'),
		input('hybrid', '- [ ] A 🆔 A {{operonId:: abc1234}}', 'ccccccc'),
		input('dependent', '- [ ] B ⛔ A', 'ddddddd'),
	]);
	assert.equal(result.items[0].conversion.kind, 'not_tasks_emoji');
	assert.equal(fields(result, 'dependent').blockedBy, undefined);
});
test('fails without side effects on duplicate source keys or target IDs', () => {
	assert.throws(() => planTasksEmojiBatchConversion([input('A', '- [ ] A 🆔 A', 'aaaaaaa'), input('A', '- [ ] B 🆔 B', 'bbbbbbb')]));
	assert.throws(() => planTasksEmojiBatchConversion([input('A', '- [ ] A 🆔 A', 'aaaaaaa'), input('B', '- [ ] B 🆔 B', 'aaaaaaa')]));
	assert.throws(() => planTasksEmojiBatchConversion([input('A', '- [ ] A 🆔 A', 'bad')]));
});

for (const [text, expected] of [
	['every month on the 15th and 1st', 'mode=schedule|freq=month|interval=1|monthdays=1,15'],
	['every 2 months on the 1st, 15th, and 1st', 'mode=schedule|freq=month|interval=2|monthdays=1,15'],
	['every January on the 15th, 1st and 24th', 'mode=schedule|freq=year|interval=1|monthdays=1,15,24|month=1'],
	['every month on the last Friday', 'mode=schedule|freq=month|interval=1|days=fr|setpos=-1'],
	['every 6 months on the 2nd Wednesday', 'mode=schedule|freq=month|interval=6|days=we|setpos=2'],
	['every 10 days when done', 'mode=done|freq=day|interval=10'],
]) {
	test(`converts supported recurrence: ${text}`, () => {
		const result = convert(`- [ ] Task 🔁 ${text} 📅 2026-10-08`);
		assert.equal(result.mappedFields.repeat, expected);
		assert.deepEqual(result.leftovers, []);
		assert.ok(parseRepeatRule(expected));
	});
}
for (const text of ['every month on the 1st and 32nd', 'every month on the 0th and 15th', 'every month on the 1st,', 'every January on the 15th and bad', 'every April and December on the 1st and 24th', 'every month on the last', 'every week on Friday when done', 'every month on the 2nd last Friday', 'every week until 2027-01-01']) {
	test(`retains unsupported/invalid entire recurrence: ${text}`, () => {
		const result = convert(`- [ ] Task 🔁 ${text} 📅 2026-10-08`);
		assert.equal(result.mappedFields.repeat, undefined);
		assert.equal(result.mappedFields.repeatOccurrenceDate, undefined);
		assert.equal(result.leftovers[0], `🔁 ${text}`);
	});
}
for (const [text, date] of [['every month', '2026-01-29'], ['every 2 months', '2026-01-30'], ['every month', '2026-01-31'], ['every year', '2024-02-29']]) {
	test(`retains unpreservable date adjustment: ${text} ${date}`, () => {
		const result = convert(`- [ ] Task 🔁 ${text} 📅 ${date}`);
		assert.equal(result.mappedFields.repeat, undefined);
		assert.match(result.leftovers[0], /date adjustment cannot be preserved/u);
	});
}
test('explicit 31st skips February, while explicit leap day repeats in the next leap year', () => {
	const monthly = parseRepeatRule(convert('- [ ] Task 🔁 every month on the 31st 📅 2026-01-31').mappedFields.repeat);
	const yearly = parseRepeatRule(convert('- [ ] Task 🔁 every February on the 29th 📅 2024-02-29').mappedFields.repeat);
	assert.ok(monthly && yearly);
	assert.equal(calculateNextRepeatDate(monthly, { anchorDate: '2026-01-31' }), '2026-03-31');
	assert.equal(calculateNextRepeatDate(yearly, { anchorDate: '2024-02-29' }), '2028-02-29');
});
test('multiple dates actually produce multiple occurrences in the same month', () => {
	const rule = parseRepeatRule(convert('- [ ] Task 🔁 every month on the 1st and 15th 📅 2026-10-01').mappedFields.repeat);
	assert.ok(rule);
	assert.equal(calculateNextRepeatDate(rule, { anchorDate: '2026-10-01' }), '2026-10-15');
	assert.equal(calculateNextRepeatDate(rule, { anchorDate: '2026-10-15' }), '2026-11-01');
});
test('adds leftovers to existing multiline notes and survives serialization round-trip', () => {
	const parsed = parseTaskLine('- [ ] Task {{operonId:: abc1234}} {{note:: Existing note}}', 0, 'A.md');
	assert.ok(parsed);
	const applied = applyTasksEmojiConversionToParsedTask({
		task: parsed, tags: [], mappedFields: {}, leftovers: ['🏁 delete (on-completion action is not supported)'],
		previousFieldValues: {}, pipelines: [], defaultPipelineName: '', defaultPriority: '',
	});
	assert.equal(applied.ok, true);
	const expected = 'Existing note\nTasks syntax leftovers: 🏁 delete (on-completion action is not supported)';
	assert.equal(parsed.fields.find(field => field.key === 'note')?.value, expected);
	const serialized = serializeTask(parsed);
	assert.equal(serialized.split('\n').length, 1);
	const roundTrip = parseTaskLine(serialized, 0, 'A.md');
	assert.equal(roundTrip?.fields.find(field => field.key === 'note')?.value, expected);
});

for (const raw of [String.raw`🆔 A\B`, '🆔 A`hidden`', String.raw`⛔ A\,B`, '⛔ A[hidden](target)']) {
	test(`never resolves a prefix touching protected Markdown: ${raw}`, () => {
		const result = planTasksEmojiBatchConversion([
			input('A', '- [ ] A 🆔 A', 'aaaaaaa'),
			input('B', `- [ ] B ${raw}`, 'bbbbbbb'),
			input('C', '- [ ] C ⛔ B', 'ccccccc'),
		]);
		assert.equal(fields(result, 'B').blockedBy, undefined);
		assert.equal(result.items[1].diagnostics[0].raw, raw);
		assert.match(result.items[1].diagnostics[0].code, /^invalid-/u);
	});
}
test('legacy generic-command compatibility never changes batch migration eligibility', () => {
	assert.equal(convertTasksEmojiLineToOperon('- [/] Custom', { legacyCustomCheckboxFallback: true }).kind, 'converted');
	const batch = planTasksEmojiBatchConversion([input('A', '- [/] Custom', 'aaaaaaa')], { legacyCustomCheckboxFallback: true });
	assert.equal(batch.items[0].conversion.kind, 'not_tasks_emoji');
});
test('shared whole-graph validation agrees with edge validation on every small directed graph', () => {
	const ids = ['a', 'b', 'c'];
	const candidates = ids.flatMap(fromId => ids.map(toId => ({ fromId, toId })));
	for (let mask = 0; mask < 512; mask++) {
		const edges = candidates.filter((_edge, index) => mask & (1 << index));
		const tasks = ids.map(operonId => ({ operonId, fieldValues: {
			blocking: edges.filter(edge => edge.fromId === operonId).map(edge => edge.toId).join('; '),
		} }));
		const expected = edges.filter(edge => !validateDependencyEdge(edge.fromId, edge.toId, tasks).ok);
		assert.deepEqual(validateDependencyEdgeSet(edges, tasks).map(({ fromId, toId }) => ({ fromId, toId })), expected);
	}
});
test('large acyclic chain plans without recursion or repeated graph rebuilds', () => {
	const inputs = Array.from({ length: 4000 }, (_value, index) => input(
		`file:${index}`, `- [ ] Task 🆔 id${index}${index ? ` ⛔ id${index - 1}` : ''}`, index.toString(36).padStart(7, '0'),
	));
	const start = performance.now();
	const result = planTasksEmojiBatchConversion(inputs);
	assert.equal(result.idMappings.length, 4000);
	assert.equal(fields(result, 'file:3999').blockedBy, (3998).toString(36).padStart(7, '0'));
	assert.ok(result.items.every(item => item.diagnostics.length === 0));
	assert.ok(performance.now() - start < 2000, '4000-task chain must complete within two seconds');
});

test('does not accept an adjoining protected suffix as a valid recurrence prefix', () => {
	const result = convert(String.raw`- [ ] Task 🔁 every day\x 📅 2026-10-08`);
	assert.equal(result.mappedFields.repeat, undefined);
	assert.match(result.leftovers[0], /invalid recurrence expression/u);
});

for (const [prefix, date, start, end, estimate] of [
 ['08:30', '2026-10-09', '2026-10-09T08:30:00', undefined, undefined],
 ['8:30-09:45', '2026-10-09', '2026-10-09T08:30:00', '2026-10-09T09:45:00', '4500'],
 ['23:00 - 01:00', '2026-12-31', '2026-12-31T23:00:00', '2027-01-01T01:00:00', '7200'],
] as const) test(`timed conversion preserves ${prefix} with explicit scheduling only`, async () => {
 const f = fixture({ 'A.md': `- [ ] ${prefix} Work ⏳ ${date}` });
 const preview = await f.preview(), task = parseTaskLine(preview.changes[0].after, 0, 'A.md')!;
 const values = Object.fromEntries(task.fields.map(field => [field.key, field.value]));
 assert.equal(values.datetimeStart, start); assert.equal(values.datetimeEnd, end); assert.equal(values.estimate, estimate);
 assert.equal(task.description, 'Work'); assert.equal(preview.rows[0].warnings.length, 0);
 await f.service.apply(preview); assert.equal(await f.adapter.read('A.md'), preview.changes[0].after);
});
for (const prefix of ['08:99', '24:00', '09:00-09:00']) test(`invalid or ambiguous clock ${prefix} is preserved as a warning`, async () => {
 const f = fixture({ 'A.md': `- [ ] ${prefix} Work ⏳ 2026-10-09` }); const p = await f.preview();
 const task = parseTaskLine(p.changes[0].after, 0, 'A.md')!;
 assert.ok(task.fields.find(field => field.key === 'note')?.value.includes(prefix));
 assert.ok(!task.fields.some(field => field.key === 'datetimeStart' || field.key === 'datetimeEnd' || field.key === 'estimate'));
 assert.ok(p.rows[0].warnings.length); assert.deepEqual(p.errors, []);
});
for (const prefix of ['08:30', '08:30-09:30', '08:30 - 09:30']) test(`unscheduled clock ${prefix} survives serialization`, async () => {
 const p = await fixture({ 'A.md': `- [ ] ${prefix} Work 📅 2026-10-09` }).preview();
 assert.ok(p.changes[0].after.startsWith(`- [ ] ${prefix} Work`));
 assert.ok(!p.changes[0].after.includes('datetimeStart::')); assert.ok(!p.changes[0].after.includes('dateScheduled::'));
});
test('conversion preserves multilingual tags and protected literal bytes through reparsing', async () => {
 const tags = ['görev', 'überprüfung', '日本語', 'العربية', 'e\u0301quipe', 'Proje/İş'];
 const literal = '`a  b` [two  words](file%20name) [[two  words]]';
 const f = fixture({ 'A.md': `- [ ] Inspect ${literal} ${tags.map(tag => '#'+tag).join(' ')} 📅 2026-10-09` });
 const p = await f.preview(), task = parseTaskLine(p.changes[0].after, 0, 'A.md')!;
 assert.deepEqual(task.tags, tags); assert.equal(task.description, 'Inspect '+literal);
 assert.equal(serializeTask(task), p.changes[0].after);
});

test('a second ordinary clock token survives conversion reparsing', async () => {
 const p = await fixture({ 'A.md': '- [ ] 08:30 09:00 Call 📅 2026-10-09' }).preview();
 assert.ok(p.changes[0].after.startsWith('- [ ] 08:30 09:00 Call'));
});
test('local scheduling validates DST gaps, elapsed time and month boundaries', () => {
 const previous = process.env.TZ; process.env.TZ = 'Europe/Berlin';
 try {
  const gap = convert('- [ ] 02:30 Work ⏳ 2026-03-29');
  assert.equal(gap.mappedFields.datetimeStart, undefined); assert.ok(gap.leftovers.join(' ').includes('02:30'));
  const range = convert('- [ ] 01:30-03:30 Work ⏳ 2026-03-29');
  assert.equal(range.mappedFields.estimate, '3600');
  const month = convert('- [ ] 23:00-01:00 Work ⏳ 2026-04-30');
  assert.equal(month.mappedFields.datetimeEnd, '2026-05-01T01:00:00');
  const invalid = convert('- [ ] 08:30 Work ⏳ 2026-02-30');
  assert.equal(invalid.mappedFields.dateScheduled, undefined); assert.equal(invalid.mappedFields.datetimeStart, undefined);
  assert.ok(invalid.leftovers.join(' ').includes('2026-02-30'));
 } finally { if (previous === undefined) delete process.env.TZ; else process.env.TZ = previous; }
});
