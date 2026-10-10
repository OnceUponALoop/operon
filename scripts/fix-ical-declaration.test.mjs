import test from 'node:test';
import assert from 'node:assert/strict';
import ts from 'typescript';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { repairVCardDeclaration } from './fix-ical-declaration.mjs';

test('declaration repair is narrow, idempotent and rejects unexpected shapes', () => {
 const input='declare class VCardTime extends Time {\n    icaltype: string;\n    clone(): VCardTime;\n}';
 const repaired=repairVCardDeclaration(input);
 assert.equal(repairVCardDeclaration(repaired),repaired);
 assert.ok(repaired.includes('clone(): VCardTime;'));
 assert.throws(()=>repairVCardDeclaration('unknown'),/Unexpected/);
 assert.throws(()=>repairVCardDeclaration(input+input),/Unexpected/);
});
test('repaired declaration retains string reads and writes with library checking enabled', async () => {
 const dir=await mkdtemp(path.join(tmpdir(),'operon-ical-types-'));
 try {
  const file=path.join(dir,'probe.ts');
  const declaration=repairVCardDeclaration('declare class VCardTime extends Time {\n    icaltype: string;\n}');
  await writeFile(file,'declare class Time { get icaltype(): string; }\n'+declaration+'\ndeclare const value: VCardTime;\nvalue.icaltype = "date-time";\nconst result: string = value.icaltype;\nvalue.icaltype = 42;');
  const program=ts.createProgram([file],{noEmit:true,types:[],skipLibCheck:false,target:ts.ScriptTarget.ES2022});
  const diagnostics=ts.getPreEmitDiagnostics(program);
  assert.deepEqual(diagnostics.map(item=>item.code),[2322]);
 } finally { await rm(dir,{recursive:true,force:true}); }
});
