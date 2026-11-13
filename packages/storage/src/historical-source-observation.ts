import {acceptanceDigest} from './acceptance.js';

export interface HistoricalSourceReview {receiptHashes:string[];artifactUris:string[]}
export interface HistoricalSourceReceipt {action_type:string;target:string;receipt_hash:string;metadata:Record<string,unknown>}
export interface HistoricalSourceArtifact {uri:string;kind:string;content:Record<string,unknown>}

/** Explicit operator observation, not proof of historical preimages, action
 * replay authority, successful deployment, or original product acceptance.
 * The caller must verify the receipt chain and bind the current source manifest.
 */
export function observeHistoricalSourceEffects(input:{files:string[];review:HistoricalSourceReview;
 receipts:HistoricalSourceReceipt[];artifacts:HistoricalSourceArtifact[]}) {
 const {receipts,artifacts,review,files}=input;
 const exact=(a:string[],b:string[])=>new Set(a).size===a.length&&a.length===b.length&&
  acceptanceDigest([...a].sort())===acceptanceDigest([...b].sort());
 if(!receipts.length||receipts.length>1000||artifacts.length!==receipts.length||
  Buffer.byteLength(JSON.stringify(input),'utf8')>16_000_000||
  !exact(review.receiptHashes,receipts.map(r=>r.receipt_hash))||
  !exact(review.artifactUris,artifacts.map(a=>a.uri)))throw Error('Complete exact historical source review required');
 const used=new Set<string>();
 for(const r of receipts){
  const m=r.metadata;
  if(r.action_type!=='file_write'||!/^[a-f0-9]{64}$/u.test(r.receipt_hash)||
   !files.includes(r.target)||!m||m.relativePath!==r.target||
   typeof m.nextHash!=='string'||!/^[a-f0-9]{64}$/u.test(m.nextHash)||
   typeof m.existed!=='boolean'||!Number.isSafeInteger(m.bytesWritten)||
   (m.bytesWritten as number)<0||
   (m.outcome!==undefined&&m.outcome!=='applied'))throw Error('Only retained finalized source-write observations qualify');
  const matches=artifacts.filter(a=>a.kind==='file_write'&&acceptanceDigest(a.content)===acceptanceDigest(m));
  if(matches.length!==1||used.has(matches[0].uri))throw Error('Historical source receipt/artifact pairing is ambiguous');
  used.add(matches[0].uri);
 }
 if(used.size!==artifacts.length)throw Error('Unpaired historical source artifacts');
 return {version:1,purpose:'operator-reviewed-historical-source-observation',
  digest:acceptanceDigest({receipts:[...receipts].sort((a,b)=>a.receipt_hash.localeCompare(b.receipt_hash)),
   artifacts:[...artifacts].sort((a,b)=>a.uri.localeCompare(b.uri))}),
  receiptHashes:[...review.receiptHashes].sort(),artifactUris:[...review.artifactUris].sort(),
  historicalPreimagesVerified:false,replayAuthorized:false,originalAcceptance:false};
}
