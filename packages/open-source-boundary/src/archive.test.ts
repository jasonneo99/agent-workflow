// boundary-synthetic-fixtures
import test from 'node:test';
import assert from 'node:assert/strict';
import {gzipSync} from 'node:zlib';
import {createHash} from 'node:crypto';
const {scanRuntimeArchive}=await import(new URL('../../../scripts/open-source-boundary-archive.mjs',import.meta.url).href) as {scanRuntimeArchive(file:string,buffer:Buffer):string[]};

const bundle='plugins/agent-workflow/runtime-bundle.tgz';
function archive(files:Array<[string,string]>){
 const entries:Buffer[]=[];
 for(const [name,text] of files){const body=Buffer.from(text),header=Buffer.alloc(512);header.write(name);header.write('0000644\0',100);header.write('0000000\0',108);header.write('0000000\0',116);header.write(body.length.toString(8).padStart(11,'0')+'\0',124);header.fill(32,148,156);header.write('0',156);header.write('ustar\0',257);const sum=header.reduce((n,b)=>n+b,0);header.write(sum.toString(8).padStart(6,'0')+'\0 ',148);entries.push(header,body,Buffer.alloc((512-body.length%512)%512));}
 return gzipSync(Buffer.concat([...entries,Buffer.alloc(1024)]));
}
test('archive validation checks decoded project payload and preserves public dependency attribution',()=>{
 const licensed='Upstream author <'+['author','upstream.org'].join('@')+'>',file='node_modules/example-package/LICENSE';
 const manifest=JSON.stringify({dependencies:[{path:'node_modules/example-package',version:'1.0.0',resolved:'https://registry.npmjs.org/example-package/-/example-package-1.0.0.tgz',integrity:'sha512-'+Buffer.alloc(64).toString('base64')}],dependencyFiles:{[file]:{packagePath:'node_modules/example-package',sha256:createHash('sha256').update(licensed).digest('hex')}}});
 const good=archive([['runtime-manifest.json',manifest],[file,licensed],['node_modules/@jasonneo99/agent-workflow/README.md','Portable project']]);
 assert.deepEqual(scanRuntimeArchive(bundle,good),[]);
 assert.match(scanRuntimeArchive(bundle,archive([['runtime-manifest.json',manifest],[file,licensed+' changed']])).join('\n'),/differs from/);
 const privatePath=['','Users','private-owner','local-data'].join('/');
 assert.match(scanRuntimeArchive(bundle,archive([['node_modules/@jasonneo99/agent-workflow/data.json',privatePath]])).join('\n'),/machine-specific user path/);
 assert.match(scanRuntimeArchive(bundle,archive([['node_modules/@jasonneo99/agent-workflow/data.json',['owner','private.org'].join('@')]])).join('\n'),/email address/);
 const credential='sk-'+('x'.repeat(30));
 assert.match(scanRuntimeArchive(bundle,archive([['node_modules/example-package/data.json',credential]])).join('\n'),/credential/);
 assert.match(scanRuntimeArchive(bundle,archive([['node_modules/example-package/README.md',privatePath]])).join('\n'),/machine-specific/);
 assert.match(scanRuntimeArchive(bundle,archive([['node_modules/jose/dist/webapi/key/import.js','-----BEGIN '+ 'PRIVATE KEY-----']])).join('\n'),/private key material/);
});
test('malformed archives, path escapes and hidden trailing data fail closed',()=>{
 assert.match(scanRuntimeArchive(bundle,Buffer.from('invalid')).join('\n'),/inspection failed/);
 assert.match(scanRuntimeArchive(bundle,archive([['../outside','hidden']])).join('\n'),/path escapes/);
 const empty=Buffer.alloc(1024);assert.match(scanRuntimeArchive(bundle,gzipSync(Buffer.concat([empty,Buffer.from('hidden payload')]))).join('\n'),/trailing archive payload/);
});
