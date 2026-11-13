export type RepairDispositionKind='archived/cancelled'|'active'|'needs-source-repair'|'needs-scoped-permission'|'needs-external-proof'|'needs-reconciliation';
export interface RepairDispositionInput {
 sourceRunId:string;projectId:string;originalStatus:string;originalGuard?:string;
 latestChild?:{assignmentSourceRunId:string;projectId:string;childRunId:string;status:string;fullChainValid:boolean;evidenceRefs:string[];
  blocker?:{kind:'source-repair'|'scoped-permission'|'external-proof'|'reconciliation';reason:string;nextAction:string}};
 recovery?:{state:string;reason:string;evidenceRefs?:string[]};
}
export interface RepairDisposition {classification:RepairDispositionKind;reason:string;nextAction:string;evidenceRefs:string[];requiresPermission:boolean;authority:'none';childRunId?:string}

/** Observation only. Typed blocker kinds must come from authenticated stage or
 * policy evidence, never from matching task text or treating prose as a grant. */
export function projectRepairDisposition(input:RepairDispositionInput):RepairDisposition {
 const make=(classification:RepairDispositionKind,reason:string,nextAction:string,evidenceRefs:string[]=[],childRunId?:string):RepairDisposition=>({classification,reason,nextAction,evidenceRefs:[...new Set(evidenceRefs)],requiresPermission:classification==='needs-scoped-permission',authority:'none',...(childRunId?{childRunId}:{})});
 if(input.originalStatus==='cancelled')return make('archived/cancelled','Original cancelled history is preserved','Do not replay or revive this original; only an explicitly authorized new task can proceed');
 const c=input.latestChild;
 const bound=Boolean(c&&c.assignmentSourceRunId===input.sourceRunId&&c.projectId===input.projectId&&c.childRunId!==input.sourceRunId&&c.fullChainValid&&c.evidenceRefs.length&&c.evidenceRefs.every(r=>typeof r==='string'&&r.length));
 if(c&&bound){
  if(['queued','running','leased'].includes(c.status))return make('active','Exact assigned child is active','Observe the existing assigned child; do not dispatch duplicate work',c.evidenceRefs,c.childRunId);
  if(c.blocker&&['failed','blocked'].includes(c.status)){
   const kinds={ 'source-repair':'needs-source-repair','scoped-permission':'needs-scoped-permission','external-proof':'needs-external-proof','reconciliation':'needs-reconciliation'} as const;
   return make(kinds[c.blocker.kind],c.blocker.reason,c.blocker.nextAction,c.evidenceRefs,c.childRunId);
  }
  if(['completed','failed','blocked','cancelled'].includes(c.status))return make('needs-reconciliation','Latest exact child is terminal; lifecycle status is not acceptance','Reconcile current source and exact original acceptance evidence without replaying terminal work',c.evidenceRefs,c.childRunId);
 }
 // An alleged latest child with unverifiable provenance must not fall back to
 // a reassuring historical label or current source-repaired observation.
 if(c&&!bound)return make('needs-reconciliation','Latest child evidence is missing exact assignment, project or valid receipt-chain binding','Recover the exact assignment and full child receipt chain before classifying its blocker');
 const r=input.recovery;
 if(r?.state==='proposal')return make('needs-scoped-permission',r.reason,'Review recovered exact source paths and approve or reject a fresh scoped baseline; no historical approval is inherited',r.evidenceRefs);
 if(r?.state==='source-repaired')return make('needs-external-proof',r.reason,'Check the remaining exact original integrated or native acceptance gates; source repair is not product acceptance',r.evidenceRefs);
 if(r&&['eligible','enrolled','waiting'].includes(r.state))return make('needs-reconciliation',r.reason,'Let Partner finish the existing bounded enrollment or dependency reconciliation before handing work back',r.evidenceRefs);
 return make('needs-reconciliation',r?.reason??input.originalGuard??'No authenticated current blocker evidence is available','Recover current exact-family evidence and distinguish technical repair, scoped permission and external proof',r?.evidenceRefs);
}
