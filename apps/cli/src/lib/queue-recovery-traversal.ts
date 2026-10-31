interface RecoveryTraversalRow {id:string;authorization:unknown|null}
/** Scheduling only. Existing exact authority is always considered before any
 * rotated proposal discovery. Neither order nor a cursor grants authority. */
export function orderPartnerRecoveryRows<T extends RecoveryTraversalRow>(rows:readonly T[],nextProposalId:string|null,startupOffset=0,nextEnrollmentId:string|null=null):T[]{
 if(rows.length>1000||new Set(rows.map(r=>r.id)).size!==rows.length||rows.some(r=>!r.id)||!Number.isSafeInteger(startupOffset)||startupOffset<0)throw Error('Invalid bounded recovery traversal');
 const authorityRows=rows.filter(r=>Boolean(r.authorization)),proposals=rows.filter(r=>!r.authorization);
 const enrollmentStart=nextEnrollmentId?Math.max(0,authorityRows.findIndex(r=>r.id===nextEnrollmentId)):0;
 const authorized=[...authorityRows.slice(enrollmentStart),...authorityRows.slice(0,enrollmentStart)];
 if(!proposals.length)return authorized;
 const next=nextProposalId?proposals.findIndex(r=>r.id===nextProposalId):-1;
 const start=next>=0?next:startupOffset%proposals.length;
 return [...authorized,...proposals.slice(start),...proposals.slice(0,start)];
}
export function nextPartnerEnrollmentId(rows:readonly RecoveryTraversalRow[],attemptedId:string):string|null{
 const authorized=rows.filter(r=>Boolean(r.authorization)),index=authorized.findIndex(r=>r.id===attemptedId);
 return index<0||!authorized.length?null:authorized[(index+1)%authorized.length]!.id;
}
export function nextPartnerProposalId(rows:readonly RecoveryTraversalRow[],observedId:string):string|null{
 const proposals=rows.filter(r=>!r.authorization),index=proposals.findIndex(r=>r.id===observedId);
 return index<0||!proposals.length?null:proposals[(index+1)%proposals.length]!.id;
}
