import assert from 'node:assert/strict';
import {readFile,readdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {CARDS} from '../js/director/cards.js';
const root=new URL('../',import.meta.url),manifest=JSON.parse(await readFile(new URL('assets/director/manifest.json',root))),rules=JSON.parse(await readFile(new URL('data/director/rules.json',root)));
const actual=(await readdir(new URL('assets/director/',root))).filter(x=>x.endsWith('.png'));
assert.equal(Object.keys(manifest.assets).length,25);assert.equal(actual.length,25);
for(const [id,a] of Object.entries(manifest.assets)){const raw=await readFile(new URL(a.path,root));assert.equal(createHash('sha256').update(raw).digest('hex'),a.sha256,id);assert.equal(raw.readUInt32BE(16),a.width);assert.equal(raw.readUInt32BE(20),a.height);assert.equal(raw.length,a.bytes);}
for(const id of rules.enabledCards){assert(CARDS[id]);assert(manifest.assets[CARDS[id].art]);}
const sources=await Promise.all(['match','cards','resolve','scenario'].map(x=>readFile(new URL(`js/director/${x}.js`,root),'utf8')));
for(const key of Object.keys(rules))assert(sources.some(x=>x.includes(`rules.${key}`)),`unused rules key ${key}`);
for(const file of ['director.html','director-lab.html']){const html=await readFile(new URL(file,root),'utf8');for(const m of html.matchAll(/(?:src|href)="([^"#?:]+)"/g))await readFile(new URL(m[1],root));}
console.log('PASS 25 asset hashes/dimensions, 6 card images, rules consumers, HTML entries');
