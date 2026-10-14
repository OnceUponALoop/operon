import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

// ical.js 2.2.1 declares a writable subclass field over a readonly base accessor.
// Describe the same readable/writable string surface as accessors, without changing
// JavaScript or disabling declaration checking for any dependency.
export function repairVCardDeclaration(source) {
 const original = '    icaltype: string;';
 const replacement = '    get icaltype(): string;\n    set icaltype(value: string);';
 if (source.includes(replacement) && !source.includes(original)) return source;
 if (source.split(original).length !== 2) throw new Error('Unexpected ical.js VCardTime declaration; review the compatibility repair');
 return source.replace(original, replacement);
}

export async function repairInstalledIcalTypes(root = new URL('../', import.meta.url)) {
 const packageRoot = new URL('node_modules/ical.js/', root);
 const metadata = JSON.parse(await readFile(new URL('package.json', packageRoot), 'utf8'));
 if (metadata.version !== '2.2.1') return;
 const target = new URL('dist/types/vcard_time.d.ts', packageRoot);
 const before = await readFile(target, 'utf8');
 const after = repairVCardDeclaration(before);
 if (before !== after) await writeFile(target, after);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await repairInstalledIcalTypes();
