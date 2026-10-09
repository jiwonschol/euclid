import assert from 'node:assert/strict';
import {readFile,readdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {CARDS} from '../js/director/cards.js';
const root=new URL('../',import.meta.url),manifest=JSON.parse(await readFile(new URL('assets/director/manifest.json',root))),rules=JSON.parse(await readFile(new URL('data/director/rules.json',root)));
const actual=(await readdir(new URL('assets/director/',root))).filter(x=>x.endsWith('.webp'));
assert.equal(Object.keys(manifest.assets).length,25);assert.equal(actual.length,25);
function webpSize(raw){assert.equal(raw.toString('ascii',0,4),'RIFF');assert.equal(raw.toString('ascii',8,12),'WEBP');const type=raw.toString('ascii',12,16);if(type==='VP8X')return [1+raw.readUIntLE(24,3),1+raw.readUIntLE(27,3)];if(type==='VP8L'){assert.equal(raw[20],0x2f);const bits=raw.readUInt32LE(21);return [1+(bits&0x3fff),1+((bits>>>14)&0x3fff)];}assert.equal(type,'VP8 ');assert.equal(raw.toString('hex',23,26),'9d012a');return [raw.readUInt16LE(26)&0x3fff,raw.readUInt16LE(28)&0x3fff];}
for(const [id,a] of Object.entries(manifest.assets)){const raw=await readFile(new URL(a.path,root));assert.equal(createHash('sha256').update(raw).digest('hex'),a.sha256,id);assert.deepEqual(webpSize(raw),[a.width,a.height],id);assert.equal(raw.length,a.bytes);}
for(const id of rules.enabledCards){assert(CARDS[id]);assert(manifest.assets[CARDS[id].art]);}
const sources=await Promise.all(['match','cards','resolve','scenario'].map(x=>readFile(new URL(`js/director/${x}.js`,root),'utf8')));
for(const key of Object.keys(rules))assert(sources.some(x=>x.includes(`rules.${key}`)),`unused rules key ${key}`);
for(const file of ['director.html','director-lab.html']){const html=await readFile(new URL(file,root),'utf8');for(const m of html.matchAll(/(?:src|href)="([^"#?:]+)"/g))await readFile(new URL(m[1],root));}
console.log('PASS 25 asset hashes/dimensions, 6 card images, rules consumers, HTML entries');
