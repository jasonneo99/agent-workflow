import { gunzipSync } from 'node:zlib';
import path from 'node:path';
import {createHash} from 'node:crypto';
import { scanBoundaryFile } from './open-source-boundary-rules.mjs';

/** Inspect actual payloads, never compressed random bytes. Only the reviewed
 * runtime archive gets this treatment; unknown binary files remain rejected. */
export function scanRuntimeArchive(file, buffer) {
  const failures = [];
  try {
    const tar = gunzipSync(buffer, { maxOutputLength: 512 * 1024 * 1024 });
    let offset = 0, count = 0, pending = {};const entries=[];
    const field = bytes => bytes.toString('utf8').replace(/\0[\s\S]*$/u, '');
    while (offset + 512 <= tar.length) {
      const header = tar.subarray(offset, offset + 512);
      if (header.every(byte => byte === 0)) {if(tar.subarray(offset).some(byte=>byte!==0))throw Error('unexpected trailing archive payload');break;}
      if (++count > 100000) throw Error('archive entry bound exceeded');
      const sizeText = field(header.subarray(124, 136)).trim();
      if (!/^[0-7]+$/u.test(sizeText)) throw Error('invalid archive size');
      const size = Number.parseInt(sizeText, 8), end = offset + 512 + size;
      const checksum=Number.parseInt(field(header.subarray(148,156)).trim(),8);
      if(!Number.isFinite(checksum)||header.reduce((sum,byte,index)=>sum+(index>=148&&index<156?32:byte),0)!==checksum)throw Error('invalid archive header checksum');
      if (!Number.isSafeInteger(size) || end > tar.length) throw Error('truncated archive entry');
      const body = tar.subarray(offset + 512, end), type = field(header.subarray(156, 157));
      offset += 512 + Math.ceil(size / 512) * 512;
      if (type === 'x' || type === 'g') {
        for (let cursor = 0; cursor < body.length;) {
          const space = body.indexOf(32, cursor), length = Number(body.subarray(cursor, space).toString());
          if (space < cursor || !Number.isInteger(length) || length <= space - cursor + 1 || cursor + length > body.length) throw Error('invalid extended archive header');
          const text = body.subarray(space + 1, cursor + length - 1).toString('utf8'), equal = text.indexOf('=');
          if (equal > 0) pending[text.slice(0, equal)] = text.slice(equal + 1);
          cursor += length;
        }
        continue;
      }
      const prefix = field(header.subarray(345, 500));
      const member = (pending.path ?? (prefix ? prefix + '/' : '') + field(header.subarray(0, 100))).replace(/^\.\//u, '');
      const link = pending.linkpath ?? field(header.subarray(157, 257)); pending = {};
      if (!member || member === '.') continue;
      if (member.startsWith('/') || member.split('/').includes('..') || member.includes('\\')) throw Error('archive path escapes');
      if (type === '5') continue;
      if (type === '1' || type === '2') {
        const target = path.posix.normalize(path.posix.join(path.posix.dirname(member), link));
        if (path.posix.isAbsolute(link) || target.startsWith('../')) throw Error('archive link escapes');
        entries.push({member,body:Buffer.from('link\0'+link),type});
        continue;
      }
      if (type !== '' && type !== '0') throw Error('unsupported archive entry type');
      entries.push({member,body,type});
    }
    if (!count || offset > tar.length) throw Error('empty or truncated archive');
    const manifestEntry=entries.find(entry=>entry.member==='runtime-manifest.json');
    if(manifestEntry?.body.length>8*1024*1024)throw Error('runtime manifest bound exceeded');
    const manifest=manifestEntry?JSON.parse(manifestEntry.body.toString('utf8')):{};
    const dependencies=new Map();
    for(const dependency of manifest.dependencies??[]){
      const url=new URL(dependency.resolved),name='(?:@[A-Za-z0-9_.-]+/)?[A-Za-z0-9_.-]+';
      if(!new RegExp(`^node_modules/${name}(?:/node_modules/${name})*$`,'u').test(dependency.path)||dependency.path==='node_modules/@jasonneo99/agent-workflow'||url.origin!=='https://registry.npmjs.org'||url.username||url.password||!/^sha(?:256|384|512)-[A-Za-z0-9+/]+=*$/u.test(dependency.integrity))throw Error('invalid public dependency provenance');
      dependencies.set(dependency.path,dependency);
    }
    for(const {member,body,type} of entries){
      const proof=manifest.dependencyFiles?.[member];
      if(proof){
        if(!dependencies.has(proof.packagePath)||!member.startsWith(proof.packagePath+'/')||createHash('sha256').update(body).digest('hex')!==proof.sha256)throw Error('dependency content differs from its integrity-bound build manifest');
        continue;
      }
      if(type==='1'||type==='2')throw Error('unattributed archive link');
      failures.push(...scanBoundaryFile(`${file}!${member}`,body));
    }
  } catch (error) { failures.push(`${file}: runtime archive inspection failed (${error.message})`); }
  return failures;
}
