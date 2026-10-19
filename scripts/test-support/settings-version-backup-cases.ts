import { OperonDataPackageStore, SettingsWritesSuspendedError } from '../../src/storage/operon-data-package-store';
import { buildOperonStoragePaths } from '../../src/storage/operon-storage-paths';
import { DEFAULT_SETTINGS } from '../../src/types/settings';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { SettingsPreservationHarness, assertBytesEqual, readSealedFixture, sha256 } from './settings-preservation-harness';

type Case = { name: string; run: () => Promise<void> };
export const settingsVersionBackupCases: Case[] = [];
const add = (name: string, run: Case['run']): void => { settingsVersionBackupCases.push({ name: `Version backup: ${name}`, run }); };
const directory = (fixture: SettingsPreservationHarness): string => `${fixture.configDir}/plugins/operon/backups/settings`;
function files(fixture: SettingsPreservationHarness): string[] {
 const root = fixture.resolve(directory(fixture));
 return existsSync(root) ? readdirSync(root) : [];
}
const copies = (fixture: SettingsPreservationHarness): string[] => files(fixture).filter(name => name.startsWith('data-') && name.endsWith('.json'));
function contents(fixture: SettingsPreservationHarness): string[] {
 return copies(fixture).map(name => readFileSync(fixture.resolve(`${directory(fixture)}/${name}`), 'utf8'));
}
async function boot(fixture: SettingsPreservationHarness, version = '3.9.1'): Promise<boolean> {
 const storage = fixture.createStorage(undefined, version);
 await storage.initialize();
 return storage.getDeveloperApiGrantDataStore().canPersist();
}
async function use(run: (fixture: SettingsPreservationHarness) => Promise<void>, initialRaw?: string | null, configDir?: string): Promise<void> {
 const fixture = new SettingsPreservationHarness({ initialRaw, configDir });
 try { await run(fixture); } finally { await fixture.dispose(); }
}

for (const version of ['3.8.0', '3.9.0']) add(`preserves exact ${version} bytes before startup and does not repeat`, async () => {
 await use(async fixture => {
  const write = fixture.adapter.write;
  fixture.adapter.write = async (path, raw) => {
   if (path === fixture.canonicalPath) assert.ok(contents(fixture).includes(fixture.initialRaw!), 'Canonical write preceded backup');
   await write(path, raw);
  };
  assert.equal(await boot(fixture), true);
  assert.deepEqual(contents(fixture), [fixture.initialRaw]);
  assert.match(copies(fixture)[0], /^data-\d{8}T\d{9}Z-before-3\.9\.1-[0-9a-f-]{36}\.json$/u);
  const names = files(fixture);
  assert.equal(await boot(fixture), true);
  assert.deepEqual(files(fixture), names);
 }, readSealedFixture(`data-${version}.json`));
});
add('uses the actual configDir', async () => {
 await use(async fixture => { assert.equal(await boot(fixture), true); assert.equal(copies(fixture).length, 1); }, undefined, '.custom-config');
});
add('first installation records version without backing up defaults', async () => {
 await use(async fixture => {
  assert.equal(await boot(fixture), true);
  assert.equal(copies(fixture).length, 0);
  assert.equal(await boot(fixture), true);
  assert.equal(copies(fixture).length, 0);
  assert.equal(await boot(fixture, '3.9.2'), true);
  assert.equal(copies(fixture).length, 1);
 }, null);
});
add('rotates only managed copies and never exceeds two permanent copies', async () => {
 await use(async fixture => {
  fixture.addSentinel(`${directory(fixture)}/manual.json`, 'manual-backup');
  const write = fixture.adapter.write;
  fixture.adapter.write = async (path, raw) => {
   await write(path, raw);
   assert.ok(copies(fixture).length <= 2);
   assert.ok(files(fixture).filter(name => name.endsWith('.tmp')).length <= 1);
  };
  assert.equal(await boot(fixture), true);
  const first = copies(fixture)[0];
  const expected = fixture.raw();
  assert.equal(await boot(fixture, '3.9.2'), true);
  const second = copies(fixture).find(name => name !== first)!;
  assert.equal(await boot(fixture, '3.9.3'), true);
  assert.equal(copies(fixture).length, 2);
  assert.ok(!copies(fixture).includes(first));
  assert.ok(copies(fixture).includes(second));
  assert.ok(contents(fixture).includes(expected!));
  assert.ok(!files(fixture).includes('pending.tmp'));
 });
});
for (const fault of ['null', 'undefined', 'throw', 'unreadable'] as const) add(`failed ${fault} source cannot rotate good backups`, async () => {
 await use(async fixture => {
  await boot(fixture);
  const before = contents(fixture);
  const canonical = fixture.raw();
  fixture.readFault = fault;
  assert.equal(await boot(fixture, '3.9.2'), false);
  assert.deepEqual(contents(fixture), before);
  assertBytesEqual(fixture.raw(), canonical);
 });
});
for (const raw of ['{broken', '{}', '{"settings":{"settingsVersion":999}}']) add(`invalid source is protected (${raw})`, async () => {
 await use(async fixture => {
  assert.equal(await boot(fixture), false);
  assert.equal(copies(fixture).length, 0);
  assert.equal(fixture.canonicalAttempts, 0);
  assertBytesEqual(fixture.raw(), raw);
 }, raw);
});

type Boundary = 'intent' | 'temporary' | 'publish' | 'finalize' | 'eviction';
type Fault = 'before' | 'silent' | 'partial' | 'after';
for (const boundary of ['intent', 'temporary', 'publish', 'finalize', 'eviction'] as Boundary[]) {
 for (const fault of ['before', 'silent', 'partial', 'after'] as Fault[]) {
  if (boundary === 'eviction' && fault === 'partial') continue;
  for (const priorCopies of [false, true]) {
  add(`${boundary} ${fault} failure with ${priorCopies ? 'two existing' : 'initial'} backups preserves settings and resumes`, async () => {
   await use(async fixture => {
    if (priorCopies || boundary === 'eviction') { await boot(fixture); await boot(fixture, '3.9.2'); }
    const source = fixture.raw();
    const attempts = fixture.canonicalAttempts;
    const target = priorCopies || boundary === 'eviction' ? '3.9.3' : '3.9.1';
    const previousNewest = copies(fixture).sort().at(-1);
    const write = fixture.adapter.write;
    const rename = fixture.adapter.rename;
    const remove = fixture.adapter.remove;
    let fired = false;
    let metadataWrites = 0;
    const act = async (path: string, raw: string, normal: () => Promise<void>): Promise<void> => {
     fired = true;
     if (fault === 'before') throw new Error('Injected before operation');
     if (fault === 'silent') return;
     if (fault === 'partial') { fixture.seed(path, raw.slice(0, 13)); throw new Error('Injected torn operation'); }
     await normal();
     throw new Error('Injected lost acknowledgement');
    };
    fixture.adapter.write = async (path, raw) => {
     if (path.includes('/metadata-')) metadataWrites++;
     const matches = boundary === 'temporary' && path.endsWith('/pending.tmp')
      || boundary === 'intent' && path.includes('/metadata-') && metadataWrites === 1
      || boundary === 'finalize' && path.includes('/metadata-') && metadataWrites === 2;
     if (!fired && matches) return await act(path, raw, () => write(path, raw));
     await write(path, raw);
    };
    fixture.adapter.rename = async (from, to) => {
     if (!fired && boundary === 'publish' && from.endsWith('/pending.tmp')) {
      // Native rename is indivisible: partial here models a damaged published file.
      return await act(to, await fixture.adapter.read(from), () => rename(from, to));
     }
     await rename(from, to);
    };
    fixture.adapter.remove = async path => {
     if (!fired && boundary === 'eviction' && path.includes('/data-')) return await act(path, '', () => remove(path));
     await remove(path);
    };
    const allowed = await boot(fixture, target);
    assert.ok(fired, 'Fault boundary was not exercised');
    if (fault !== 'after') {
     assert.equal(allowed, false);
     assertBytesEqual(fixture.raw(), source);
     assert.equal(fixture.canonicalAttempts, attempts);
     fixture.storages.at(-1)!.resumeCanonicalSettingsWrites();
     assert.equal(fixture.storages.at(-1)!.getDeveloperApiGrantDataStore().canPersist(), false);
    } else assert.equal(allowed, true);
    assert.ok(copies(fixture).length <= 2);
    if (previousNewest) assert.ok(copies(fixture).includes(previousNewest), 'Last sound permanent backup was lost');
    fixture.adapter.write = write; fixture.adapter.rename = rename; fixture.adapter.remove = remove;
    const recoverable = !(boundary === 'publish' && fault === 'partial');
    const backupPaused = boundary === 'intent' && fault === 'partial' && !priorCopies;
    assert.equal(await boot(fixture, target), recoverable);
    const names = copies(fixture);
    assert.equal(await boot(fixture, target), recoverable);
    assert.deepEqual(copies(fixture), names);
    assert.ok(names.length <= 2);
    if (recoverable && !backupPaused) assert.ok(contents(fixture).includes(source!));
   });
  });
  }
 }
}
add('changed retained backup is preserved without blocking settings', async () => {
 await use(async fixture => {
  await boot(fixture); await boot(fixture, '3.9.2');
  const oldest = copies(fixture).sort()[0];
  fixture.seed(`${directory(fixture)}/${oldest}`, 'externally edited');
  const before = contents(fixture);
  assert.equal(await boot(fixture, '3.9.3'), true);
  assert.deepEqual(contents(fixture), before);
 });
});
add('source drift during backup blocks startup writes', async () => {
 await use(async fixture => {
  const write = fixture.adapter.write;
  const changed = `${fixture.initialRaw}\n`;
  fixture.adapter.write = async (path, raw) => {
   await write(path, raw);
   if (path.endsWith('/pending.tmp')) fixture.seed(fixture.canonicalPath, changed);
  };
  assert.equal(await boot(fixture), false);
  assert.equal(fixture.canonicalAttempts, 0);
  assertBytesEqual(fixture.raw(), changed);
 });
});
add('first-install interruption before canonical publication leaves no backup marker', async () => {
 await use(async fixture => {
  const store = new OperonDataPackageStore(fixture.adapter, buildOperonStoragePaths(fixture.configDir), fixture.pluginData, undefined, undefined, '3.9.1');
  await store.initialize(DEFAULT_SETTINGS, 'en');
  assert.equal(store.canPersist(), true);
  assert.equal(fixture.raw(), null);
  assert.deepEqual(files(fixture), []);
  assert.equal(await boot(fixture), true);
  assert.equal(copies(fixture).length, 0);
 }, null);
});
add('supported schema 1 is backed up before migration', async () => {
 const source = JSON.parse(readSealedFixture('data-3.8.0.json')) as Record<string, unknown>;
 source.schemaVersion = 1;
 await use(async fixture => {
  assert.equal(await boot(fixture), true);
  assert.deepEqual(contents(fixture), [fixture.initialRaw]);
  assert.equal(fixture.package().schemaVersion, 2);
 }, JSON.stringify(source));
});
add('unowned automatic-looking copy pauses backups without blocking settings', async () => {
 await use(async fixture => {
  const name = 'data-20260915T143000000Z-before-3.9.0-00000000-0000-0000-0000-000000000000.json';
  fixture.addSentinel(`${directory(fixture)}/${name}`, fixture.initialRaw!);
  assert.equal(await boot(fixture), true);
  assert.equal(copies(fixture).length, 1);

 });
});
add('concurrent stores serialize backup creation and do not duplicate', async () => {
 await use(async fixture => {
  await Promise.all([boot(fixture), boot(fixture)]);
  assert.equal(copies(fixture).length, 1);
  assert.deepEqual(contents(fixture), [fixture.initialRaw]);
 });
});
add('both invalid metadata slots pause backups without deleting good copies', async () => {
 await use(async fixture => {
  await boot(fixture);
  const before = contents(fixture);
  fixture.seed(`${directory(fixture)}/metadata-0.json`, '{torn');
  fixture.seed(`${directory(fixture)}/metadata-1.json`, '{torn');
  assert.equal(await boot(fixture, '3.9.2'), true);
  assert.deepEqual(contents(fixture), before);
 });
});
add('failed initial version marker keeps verified canonical and recovers on restart', async () => {
 await use(async fixture => {
  const write = fixture.adapter.write;
  fixture.adapter.write = async (path, raw) => {
   if (path.includes('/metadata-')) throw new Error('Initial marker failed');
   await write(path, raw);
  };
  assert.equal(await boot(fixture), false);
  assert.notEqual(fixture.raw(), null);
  const initial = fixture.raw();
  fixture.adapter.write = write;
  assert.equal(await boot(fixture), true);
  assert.deepEqual(contents(fixture), [initial]);
 }, null);
});

for (const [domain, name] of [['views', 'tablePresets'], ['ui', 'taskCreationProfile'], ['integrations', 'developerApi']] as const) {
 add(`future ${name} cannot displace a good backup`, async () => {
  await use(async fixture => {
   await boot(fixture);
   const source = JSON.parse(fixture.raw()!) as Record<string, Record<string, Record<string, unknown>>>;
   source[domain][name].version = 999;
   const raw = JSON.stringify(source);
   fixture.seed(fixture.canonicalPath, raw);
   const before = contents(fixture);
   assert.equal(await boot(fixture, '3.9.2'), false);
   assert.deepEqual(contents(fixture), before);
   assertBytesEqual(fixture.raw(), raw);
  });
 });
}

add('verified future metadata never falls back to an older journal', async () => {
 await use(async fixture => {
  await boot(fixture);
  const before = contents(fixture);
  const path = `${directory(fixture)}/metadata-1.json`;
  const envelope = JSON.parse(await fixture.adapter.read(path)) as { payload: { version: number }; sha256: string };
  envelope.payload.version = 2;
  envelope.sha256 = sha256(JSON.stringify(envelope.payload));
  fixture.seed(path, JSON.stringify(envelope));
  assert.equal(await boot(fixture, '3.9.2'), false);
  assert.deepEqual(contents(fixture), before);
  assert.equal(JSON.parse(await fixture.adapter.read(path)).payload.version, 2);
 });
});
add('manual backup, reload and resume cannot bypass failed required backup', async () => {
 await use(async fixture => {
  const write = fixture.adapter.write;
  fixture.adapter.write = async (path, raw) => {
   if (path.endsWith('/pending.tmp')) throw new Error('Required backup failed');
   await write(path, raw);
  };
  assert.equal(await boot(fixture), false);
  fixture.adapter.write = write;
  const storage = fixture.storages.at(-1)!;
  await storage.backupCanonicalSettingsPackage();
  try { await storage.reloadCanonicalSettingsPackage(); } catch { /* A blocked normalization may reject. */ }
  storage.resumeCanonicalSettingsWrites();
  assert.equal(storage.getDeveloperApiGrantDataStore().canPersist(), false);
  await assert.rejects(storage.getDeveloperApiGrantDataStore().updateDataPackage(current => current));
  assert.equal(fixture.canonicalAttempts, 0);
  assertBytesEqual(fixture.raw(), fixture.initialRaw);
 });
});
for (const boundary of ['pending.tmp', 'metadata-0.json', 'published']) add(`read failure at ${boundary} blocks writes and resumes`, async () => {
 await use(async fixture => {
  const read = fixture.adapter.read;
  let fired = false;
  fixture.adapter.read = async path => {
   if (!fired && (boundary === 'published' ? path.includes('/data-') : path.endsWith(`/${boundary}`))) {
    fired = true;
    throw new Error('Injected verification read failure');
   }
   return await read(path);
  };
  assert.equal(await boot(fixture), false);
  assert.ok(fired);
  assert.equal(fixture.canonicalAttempts, 0);
  assertBytesEqual(fixture.raw(), fixture.initialRaw);
  fixture.adapter.read = read;
  assert.equal(await boot(fixture), true);
  assert.deepEqual(contents(fixture), [fixture.initialRaw]);
 });
});

const orphanName = 'data-20260915T143000000Z-before-3.9.0-00000000-0000-0000-0000-000000000000.json';
const backupSnapshot = (fixture: SettingsPreservationHarness): Record<string,string> => Object.fromEntries(
 files(fixture).map(name => [name,readFileSync(fixture.resolve(`${directory(fixture)}/${name}`),'utf8')]));
for (const conflict of ['synced-orphan', 'lost-journals', 'torn-journals', 'ambiguous-journals', 'missing-copy', 'changed-copy', 'orphan-temporary', 'interrupted-other-source']) {
 add(`sync ${conflict} permits settings save and restart without modifying backup evidence`, async () => {
  await use(async fixture => {
   await boot(fixture);
   const root=directory(fixture), snapshot=backupSnapshot(fixture);
   const latest=JSON.parse(snapshot['metadata-1.json']);
   fixture.addSentinel(`${root}/metadata-1 (device conflicted copy).json`,snapshot['metadata-1.json']);
   if(conflict==='synced-orphan') fixture.addSentinel(`${root}/${orphanName}`,fixture.initialRaw!);
   if(conflict==='lost-journals') for(const slot of [0,1]) rmSync(fixture.resolve(`${root}/metadata-${slot}.json`));
   if(conflict==='torn-journals') for(const slot of [0,1]) fixture.seed(`${root}/metadata-${slot}.json`,'{incomplete');
   if(conflict==='ambiguous-journals') {
    latest.payload.processedVersion='3.9.0';latest.sha256=sha256(JSON.stringify(latest.payload));
    fixture.seed(`${root}/metadata-0.json`,JSON.stringify(latest));
   }
   if(conflict==='missing-copy') rmSync(fixture.resolve(`${root}/${copies(fixture)[0]}`));
   if(conflict==='changed-copy') fixture.seed(`${root}/${copies(fixture)[0]}`,'changed by sync');
   if(conflict==='orphan-temporary') fixture.seed(`${root}/pending.tmp`,'synced temporary');
   if(conflict==='interrupted-other-source') {
    latest.payload.pending={targetVersion:'3.9.2',entry:{name:orphanName.replace('3.9.0','3.9.2'),digest:'0'.repeat(64)}};
    latest.sha256=sha256(JSON.stringify(latest.payload));fixture.seed(`${root}/metadata-1.json`,JSON.stringify(latest));
   }
   const before=backupSnapshot(fixture);let blocked=0;const warnings:unknown[][]=[];const warn=console.warn;
   const storage=fixture.createStorage(()=>blocked++,'3.9.2');
   try { console.warn=(...args:unknown[])=>{warnings.push(args);};await storage.initialize(); } finally {console.warn=warn;}
   assert.equal(storage.getDeveloperApiGrantDataStore().canPersist(),true);
   assert.equal(blocked,0);assert.equal(warnings.filter(args=>String(args[0]).includes('Settings saving remains available')).length,1);
   assert.ok(!warnings.some(args=>String(args[0]).includes('writes are suspended')));
   storage.getSettings().calendarSidebarShowWeekNumbers=false;await storage.saveSettings();
   assert.deepEqual(backupSnapshot(fixture),before);
   const reopened=fixture.createStorage(()=>blocked++,'3.9.2');await reopened.initialize();
   assert.equal(reopened.getSettings().calendarSidebarShowWeekNumbers,false);
   assert.equal(reopened.getDeveloperApiGrantDataStore().canPersist(),true);assert.equal(blocked,0);
   assert.deepEqual(backupSnapshot(fixture),before);
  });
 });
}
for(const fault of ['changed-during-check','unreadable-during-check','changed-before-save','failed-save'] as const) {
 add(`sync conflict does not bypass canonical ${fault} protection`,async()=>{
  await use(async fixture=>{
   await boot(fixture);fixture.addSentinel(`${directory(fixture)}/${orphanName}`,fixture.initialRaw!);
   const before=fixture.raw(), attempts=fixture.canonicalAttempts;const list=fixture.adapter.list;
   if(fault.endsWith('during-check')) fixture.adapter.list=async path=>{
    const result=await list(path);
    if(path===directory(fixture)) {
     if(fault==='changed-during-check') fixture.seed(fixture.canonicalPath,before+'\n');
     else fixture.readFault='unreadable';
    }
    return result;
   };
   let blocked=0;const storage=fixture.createStorage(()=>blocked++,'3.9.2');await storage.initialize();
   if(fault.endsWith('during-check')) {
    assert.equal(storage.getDeveloperApiGrantDataStore().canPersist(),false);
    assert.equal(fixture.canonicalAttempts,attempts);assert.ok(blocked>0);
   } else {
    assert.equal(storage.getDeveloperApiGrantDataStore().canPersist(),true);
    if(fault==='changed-before-save')fixture.seed(fixture.canonicalPath,before+'\n');else fixture.writeFault='silent-before';
    storage.getSettings().calendarSidebarShowWeekNumbers=false;
    await assert.rejects(storage.saveSettings());
    assertBytesEqual(fixture.raw(),fault==='changed-before-save'?before+'\n':before);
   }
  });
 });
}

add('settings pause emits one cause-aware warning and retains the write lock', async () => {
 await use(async fixture => {
  const storage=fixture.createStorage();await storage.initialize();
  const warnings: unknown[][]=[];const warn=console.warn;
  try {
   console.warn=(...args:unknown[])=>{warnings.push(args);};
   for(let i=0;i<5;i++)storage.suspendCanonicalSettingsWrites('required backup failed');
   assert.equal(warnings.length,1);
   assert.equal(storage.canRunTablePresetFileRecovery(),false);
   const attempts=fixture.canonicalAttempts;
   for(let i=0;i<3;i++)await assert.rejects(storage.saveSettings(),SettingsWritesSuspendedError);
   assert.equal(fixture.canonicalAttempts,attempts);
   storage.suspendCanonicalSettingsWrites('different read failure');assert.equal(warnings.length,2);
   storage.resumeCanonicalSettingsWrites();assert.equal(storage.canPersistSettings(),true);
   storage.suspendCanonicalSettingsWrites('required backup failed');assert.equal(warnings.length,3);
  } finally {console.warn=warn;}
 });
});
add('failed required version backup reports one warning with its original cause',async()=>{
 await use(async fixture=>{
  const write=fixture.adapter.write;fixture.adapter.write=async(path,raw)=>{if(path.endsWith('/pending.tmp'))throw new Error('disk unavailable');await write(path,raw);};
  const warnings:unknown[][]=[];const warn=console.warn;
  try{
   console.warn=(...args:unknown[])=>{warnings.push(args);};
   const storage=fixture.createStorage(undefined,'3.9.2');await storage.initialize();
   assert.equal(storage.canPersistSettings(),false);assert.equal(storage.canRunTablePresetFileRecovery(),false);
   assert.equal(warnings.length,1);assert.match(String(warnings[0][0]),/settings saving is paused/);
   assert.match(JSON.stringify(warnings[0][1]),/Automatic settings backup could not be verified/);
   assert.ok((warnings[0][1] as {cause?:unknown}).cause instanceof Error);
   assert.equal(fixture.canonicalAttempts,0);assertBytesEqual(fixture.raw(),fixture.initialRaw);
  }finally{console.warn=warn;}
 });
});

add('repeated unreadable reloads preserve one warning and recover through the existing reload path',async()=>{
 await use(async fixture=>{
  let notices=0;const storage=fixture.createStorage(()=>{notices++;});await storage.initialize();
  const read=fixture.adapter.read;const before=fixture.raw();const attempts=fixture.canonicalAttempts;
  const warnings:unknown[][]=[];const warn=console.warn;
  try{
   console.warn=(...args:unknown[])=>{warnings.push(args);};
   fixture.adapter.read=async path=>{if(path===fixture.canonicalPath)throw new Error('read unavailable');return read(path);};
   for(let i=0;i<5;i++)await storage.reloadCanonicalSettingsPackage();
   assert.equal(warnings.length,1);assert.equal(notices,1);assert.equal(storage.canPersistSettings(),false);
   assert.equal(storage.canRunTablePresetFileRecovery(),false);assert.equal(fixture.canonicalAttempts,attempts);
   assertBytesEqual(fixture.raw(),before);
   fixture.adapter.read=read;await storage.reloadCanonicalSettingsPackage();assert.equal(storage.canPersistSettings(),true);
   fixture.adapter.read=async path=>{if(path===fixture.canonicalPath)throw new Error('read unavailable');return read(path);};
   await storage.reloadCanonicalSettingsPackage();assert.equal(warnings.length,2);assert.equal(notices,2);
  }finally{fixture.adapter.read=read;console.warn=warn;}
 });
});
