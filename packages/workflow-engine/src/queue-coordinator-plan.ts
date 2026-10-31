/** Scheduling advice only: this module grants no authority and changes no run state. */
export const QUEUE_SHARED_ITEM_LIMIT=5;
export interface QueueCoordinatorFamily {
  familyId: string;
  sourceRunId: string;
  projectId: string;
  projectRootUri: string;
  canonical: boolean;
  activeRunIds: string[];
  /** Proven non-leasable queued descendants reserve overlaps, not capacity. */
  reconciliationHoldReason?: string;
  /** Exact storage-validated human exception; planning advice never grants it. */
  quarantineOverlap?: {blockedCloneRunId:string;authorizationReceiptHash:string};
  pendingApprovalIds: string[];
  fileScopes: string[];
  failureFingerprint: string;
  priorFingerprint: string | null;
  repairDepth: number;
  verificationReady: boolean;
  originalAcceptancePresent: boolean;
  sourceEvidenceReady: boolean;
  blocker: string;
  requiredProvider?:string|null;
  sharedBlockerKey?: string;
  priority?: number;
  /** Evidence-backed route toward acceptance; scheduling advice, never authority. */
  resolutionStrategy?: "verify-sealed-candidate" | "reconcile-owned-effects" | "repair-exact-source" | "discover-missing-scope" | "fresh-delivery";
  /** Original terminal time used only to age unresolved blocked work fairly. */
  blockedSince?: string;
  /** Prior terminal Partner attempts that did not close original acceptance. */
  nonResolvingAttempts?: number;
}

export interface QueueCoordinatorPlan {
  repairs: Array<{ lane: number; family: QueueCoordinatorFamily }>;
  verifiers: Array<{ lane: number; family: QueueCoordinatorFamily }>;
  holds: Array<{ familyId: string; reason: string }>;
  sharedBlockers: Array<{ key: string; familyIds: string[] }>;
}
export interface QueueAdmissionPressure {
  storageReady:boolean;
  providerReady:boolean;
  verifierReady:boolean;
  /** New reservations allowed in this pass after preserving existing owners. */
  newItemLimit:number;
  availableProviders?:string[];
  unavailableProviders?:string[];
}

const compare = (a: string, b: string): number => a < b ? -1 : a > b ? 1 : 0;
const strategyValue:Record<NonNullable<QueueCoordinatorFamily["resolutionStrategy"]>,number>={
  "verify-sealed-candidate":500,
  "reconcile-owned-effects":450,
  "repair-exact-source":400,
  "discover-missing-scope":200,
  "fresh-delivery":100
};
export function compareQueueCoordinatorResolution(a:QueueCoordinatorFamily,b:QueueCoordinatorFamily,adaptiveStrategyOrder:readonly string[]=[]):number{
 const aAdaptive=adaptiveStrategyOrder.indexOf(a.resolutionStrategy??''),bAdaptive=adaptiveStrategyOrder.indexOf(b.resolutionStrategy??'');
 return Number(b.verificationReady)-Number(a.verificationReady)
  ||Number(Boolean(b.blockedSince))-Number(Boolean(a.blockedSince))
  ||(aAdaptive>=0&&bAdaptive>=0?aAdaptive-bAdaptive:0)
  ||strategyValue[b.resolutionStrategy??"fresh-delivery"]-strategyValue[a.resolutionStrategy??"fresh-delivery"]
  ||(a.nonResolvingAttempts??0)-(b.nonResolvingAttempts??0)
  ||(a.blockedSince&&b.blockedSince?Date.parse(a.blockedSince)-Date.parse(b.blockedSince):0)
  ||(b.priority??0)-(a.priority??0);
}
const externalBlocker = /\b(native|external|deploy(?:ment)?|credential\w*|privileg\w*|activation|restart|install(?:ed|ation)?|signing|live[- ]grant|user[- ]acceptance)\b/i;
const unknownScope = (scope: string): boolean => !scope.trim() || /[*?\[\]{}\\]/.test(scope) || /^(?:\.|\/|global|unknown)$/i.test(scope);
const normalizeScope = (scope: string): string => scope.replace(/\/+$/, "");
function scopesOverlap(left: QueueCoordinatorFamily, right: QueueCoordinatorFamily): boolean {
  if (left.projectId !== right.projectId && left.projectRootUri !== right.projectRootUri) return false;
  if (!left.fileScopes.length || !right.fileScopes.length) return true;
  return left.fileScopes.some(a => right.fileScopes.some(b => {
    if (unknownScope(a) || unknownScope(b)) return true;
    const x = normalizeScope(a), y = normalizeScope(b);
    return x === y || x.startsWith(`${y}/`) || y.startsWith(`${x}/`);
  }));
}
function reservesOverlap(candidate:QueueCoordinatorFamily,other:QueueCoordinatorFamily):boolean {
  const exception=candidate.quarantineOverlap;
  if(exception&&!candidate.verificationReady&&/^[a-f0-9]{64}$/u.test(exception.authorizationReceiptHash)
    &&candidate.projectId===other.projectId&&candidate.familyId!==other.familyId
    &&other.reconciliationHoldReason&&other.activeRunIds.length===1
    &&other.activeRunIds[0]===exception.blockedCloneRunId)return false;
  return scopesOverlap(candidate,other);
}

export function planQueueCoordinator(
  families: readonly QueueCoordinatorFamily[],
  options: { repairLanes?: number; verifierLanes?: number; maxItems?: number; verifierOccupied?: boolean; occupiedRepairLanes?:readonly number[];admission?:QueueAdmissionPressure;adaptiveStrategyOrder?:readonly string[] } = {}
): QueueCoordinatorPlan {
  const repairLanes = options.repairLanes ?? 5, verifierLanes = options.verifierLanes ?? 1;
  const maxItems=options.maxItems??5;
  if(!Number.isInteger(maxItems)||maxItems<1||maxItems>QUEUE_SHARED_ITEM_LIMIT)throw Error('Total item capacity must be an integer between 1 and 5');
  const admission=options.admission??{storageReady:true,providerReady:true,verifierReady:true,newItemLimit:5,availableProviders:[],unavailableProviders:[]};
  if(typeof admission.storageReady!=='boolean'||typeof admission.providerReady!=='boolean'||typeof admission.verifierReady!=='boolean'
    ||!Number.isInteger(admission.newItemLimit)||admission.newItemLimit<0||admission.newItemLimit>QUEUE_SHARED_ITEM_LIMIT
    ||(admission.availableProviders!==undefined&&!Array.isArray(admission.availableProviders))||(admission.unavailableProviders!==undefined&&!Array.isArray(admission.unavailableProviders))
    ||[...(admission.availableProviders??[]),...(admission.unavailableProviders??[])].some(provider=>typeof provider!=='string'||!provider.trim()))throw Error('Invalid queue admission pressure');
  for (const value of [repairLanes, verifierLanes]) {
    if (!Number.isInteger(value) || value < 1 || value > QUEUE_SHARED_ITEM_LIMIT) throw new Error("Lane count must be an integer between 1 and 5");
  }
  if(verifierLanes!==1)throw Error('Only one verifier lane is supported inside the shared total');
  const ids = new Set<string>();
  for (const family of families) {
    if (!family.familyId?.trim() || ids.has(family.familyId)) throw new Error("Missing or duplicate family identity");
    ids.add(family.familyId);
    if (!Number.isInteger(family.repairDepth) || family.repairDepth < 0 || (family.priority !== undefined && !Number.isFinite(family.priority))
      ||(family.nonResolvingAttempts!==undefined&&(!Number.isInteger(family.nonResolvingAttempts)||family.nonResolvingAttempts<0))
      ||(family.blockedSince!==undefined&&!Number.isFinite(Date.parse(family.blockedSince)))) throw new Error("Invalid family ranking metadata");
  }
  const groups = new Map<string, QueueCoordinatorFamily[]>();
  for (const family of families) {
    if (family.sharedBlockerKey?.trim()) groups.set(family.sharedBlockerKey, [...(groups.get(family.sharedBlockerKey) ?? []), family]);
  }
  const rank = (a: QueueCoordinatorFamily, b: QueueCoordinatorFamily): number =>
    compareQueueCoordinatorResolution(a,b,options.adaptiveStrategyOrder) ||
    (groups.get(b.sharedBlockerKey ?? "")?.length ?? 0) - (groups.get(a.sharedBlockerKey ?? "")?.length ?? 0) || compare(a.familyId, b.familyId);
  const sorted = [...families].sort(rank);
  const plan: QueueCoordinatorPlan = { repairs: [], verifiers: [], holds: [], sharedBlockers: [...groups].sort(([a], [b]) => compare(a, b)).map(([key, members]) => ({ key, familyIds: members.map(f => f.familyId).sort(compare) })) };
  const active = sorted.filter(f => f.activeRunIds.length > 0);
  const executing = active.filter(f => !f.reconciliationHoldReason);
  const reserved = [...active];
  // Unknown active lane roles consume repair capacity conservatively.
  const occupiedRepairLanes=options.occupiedRepairLanes??Array.from({length:executing.length},(_,i)=>i+1);
  if(occupiedRepairLanes.some(lane=>!Number.isInteger(lane)||lane<1||lane>32)||new Set(occupiedRepairLanes).size!==occupiedRepairLanes.length)throw Error('Invalid occupied repair lanes');
  const availableRepairLanes=Array.from({length:repairLanes},(_,i)=>i+1).filter(lane=>!occupiedRepairLanes.includes(lane));
  const repairCapacity = Math.max(0, Math.min(repairLanes - executing.length,availableRepairLanes.length));
  const verifierOccupied=options.verifierOccupied??executing.some(f=>f.verificationReady);
  const representative = new Map([...groups].map(([key, members]) => [key, [...members].sort((a, b) => Number(b.activeRunIds.length > 0) - Number(a.activeRunIds.length > 0) || rank(a, b))[0].familyId]));
  for (const family of sorted) {
    let reason: string | undefined;
    if (!admission.storageReady) reason = "storage backpressure";
    else if (!family.canonical) reason = "noncanonical execution scope";
    else if (family.reconciliationHoldReason) reason = family.reconciliationHoldReason;
    else if (family.activeRunIds.length) reason = "family already active";
    else if (family.pendingApprovalIds.length) reason = "pending approval";
    else if (!family.sourceRunId?.trim() || !family.projectId?.trim() || !family.projectRootUri?.trim() || !family.sourceEvidenceReady || !family.originalAcceptancePresent) reason = "missing source evidence or original acceptance";
    else if (!family.failureFingerprint?.trim() || !family.fileScopes.length || family.fileScopes.some(s => !s.trim() || s.startsWith("/") || s.split("/").includes("..") || (s !== "." && s.split("/").includes(".")))) reason = "missing or invalid scope or failure fingerprint";
    else if (externalBlocker.test(family.blocker)) reason = "external proof or authority required";
    else if (family.verificationReady) {
      if (!admission.verifierReady) reason = "verifier backpressure";
      else if (reserved.some(other => reservesOverlap(family, other))) reason = "overlapping execution scope";
      else if (executing.length+plan.repairs.length+plan.verifiers.length>=maxItems) reason = "item capacity";
      else if (plan.repairs.length+plan.verifiers.length>=admission.newItemLimit) reason = "admission backpressure";
      else if (!verifierOccupied && plan.verifiers.length < verifierLanes) {
        plan.verifiers.push({ lane: plan.verifiers.length + 1, family });
        reserved.push(family);
      }
      else reason = "verifier capacity";
      if (!reason) continue;
    } else if (family.repairDepth > 0) reason = "repair-of-repair suppressed";
    else if (family.priorFingerprint === family.failureFingerprint) reason = "unchanged failure suppressed";
    else if (family.sharedBlockerKey && representative.get(family.sharedBlockerKey) !== family.familyId) reason = "shared blocker representative scheduled first";
    else if (!admission.providerReady||(family.requiredProvider&&(admission.availableProviders??[]).length&&!(admission.availableProviders??[]).includes(family.requiredProvider))) reason = "provider backpressure";
    else if (reserved.some(other => reservesOverlap(family, other))) reason = "overlapping execution scope";
    else if (executing.length+plan.repairs.length+plan.verifiers.length>=maxItems) reason = "item capacity";
    else if (plan.repairs.length+plan.verifiers.length>=admission.newItemLimit) reason = "admission backpressure";
    else if (plan.repairs.length >= repairCapacity) reason = "repair capacity";
    else {
      plan.repairs.push({ lane: availableRepairLanes[plan.repairs.length], family });
      reserved.push(family);
      continue;
    }
    plan.holds.push({ familyId: family.familyId, reason });
  }
  return plan;
}
