import type { Pool, PoolConnection, ResultSetHeader, RowDataPacket } from "mysql2/promise";
import { cosineSimilarity } from "./similarity.js";
import type { AnalysisInput, CandidateEvent, ClusterMember, ClusterScene, CoverageGap, QueryCluster } from "./types.js";

export interface AnalysisRepository {
  transaction<T>(work: (repository: AnalysisRepository) => Promise<T>): Promise<T>;
  withBatchLock<T>(work: (repository: AnalysisRepository) => Promise<T>): Promise<T | null>;
  insertInput(input: AnalysisInput): Promise<boolean>;
  listPendingInputs(limit: number): Promise<AnalysisInput[]>;
  listCandidateClusters(type: QueryCluster["clusterType"], projectScope: string | null, modulePathHash: string | null): Promise<QueryCluster[]>;
  createCluster(cluster: Omit<QueryCluster, "id">): Promise<QueryCluster>;
  addMember(member: ClusterMember): Promise<boolean>;
  listRepresentativeQueries(clusterId: number, limit: number): Promise<string[]>;
  listMemberVectors(clusterId: number): Promise<number[][]>;
  updateCentroid(clusterId: number, centroidVector: number[], embeddingModelVersion: string): Promise<void>;
  rebuildCentroid(clusterId: number, centroidVector: number[], embeddingModelVersion: string): Promise<void>;
  upsertScene(scene: ClusterScene): Promise<void>;
  addCoverageGap(gap: CoverageGap): Promise<boolean>;
  recalculateCluster(clusterId: number): Promise<QueryCluster>;
  mergeClusters(targetClusterId: number, sourceClusterId: number): Promise<void>;
  appendScore(clusterId: number, clusterVersion: number, scoreType: string, scoreValue: number | null, reason: Record<string, unknown>): Promise<void>;
  handOffCandidate(clusterId: number, event: CandidateEvent): Promise<boolean>;
  hasCandidate(clusterId: number, clusterVersion: number, candidateType: CandidateEvent["candidateType"]): Promise<boolean>;
  findLatestCandidate(clusterId: number): Promise<CandidateEvent | null>;
  markAnalyzed(inputId: number, analyzedAt: Date): Promise<void>;
  listScenes(clusterId: number): Promise<Array<{ sceneType: string; sampleCount: number; successCount: number; riskLevel: string; toolPath: Array<{ projectId: string; moduleId: string | null; toolName: string; serviceVersionId: string | null; toolVersionId: string | null; operation: string | null }> }>>;
  listOutbox(): Promise<CandidateEvent[]>;
  claimCandidateEvents(workerId: string, now: Date, leaseMs: number, limit: number): Promise<CandidateEvent[]>;
  markCandidateDelivered(eventId: string, workerId: string, at: Date): Promise<boolean>;
  markCandidateFailure(eventId: string, workerId: string, nextAttemptAt: Date, maxAttempts: number): Promise<boolean>;
  listClusters(): Promise<QueryCluster[]>;
}

function clone<T>(value: T): T {
  if (value instanceof Date) return new Date(value) as T;
  if (Array.isArray(value)) return value.map(clone) as T;
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, clone(item)])) as T;
  return value;
}

export class MemoryAnalysisRepository implements AnalysisRepository {
  private inputs: AnalysisInput[] = [];
  private clusters: QueryCluster[] = [];
  private members: ClusterMember[] = [];
  private scenes = new Map<string, { scene: ClusterScene; sampleCount: number; successCount: number }>();
  private gaps: CoverageGap[] = [];
  private outbox: CandidateEvent[] = [];
  private candidateDelivery = new Map<string, { status: "pending" | "delivering" | "delivered" | "dead"; attempts: number; owner: string | null; leaseUntil: Date | null; nextAttemptAt: Date }>();
  private nextInputId = 1;
  private nextClusterId = 1;
  private batchLocked = false;

  async transaction<T>(work: (repository: AnalysisRepository) => Promise<T>): Promise<T> {
    const snapshot = {
      inputs: clone(this.inputs), clusters: clone(this.clusters), members: clone(this.members),
      scenes: clone([...this.scenes.entries()]), gaps: clone(this.gaps), outbox: clone(this.outbox), candidateDelivery: clone([...this.candidateDelivery.entries()]),
      nextInputId: this.nextInputId, nextClusterId: this.nextClusterId,
    };
    try {
      return await work(this);
    } catch (error) {
      this.inputs = snapshot.inputs; this.clusters = snapshot.clusters; this.members = snapshot.members;
      this.scenes = new Map(snapshot.scenes); this.gaps = snapshot.gaps; this.outbox = snapshot.outbox; this.candidateDelivery = new Map(snapshot.candidateDelivery);
      this.nextInputId = snapshot.nextInputId; this.nextClusterId = snapshot.nextClusterId;
      throw error;
    }
  }
  async withBatchLock<T>(work: (repository: AnalysisRepository) => Promise<T>): Promise<T | null> {
    if (this.batchLocked) return null;
    this.batchLocked = true;
    try { return await work(this); } finally { this.batchLocked = false; }
  }
  async insertInput(input: AnalysisInput): Promise<boolean> {
    if (this.inputs.some((item) => item.eventId === input.eventId || (item.turnId === input.turnId && item.settlementVersion === input.settlementVersion))) return false;
    const latest = this.inputs.filter((item) => item.turnId === input.turnId).sort((a, b) => b.settlementVersion - a.settlementVersion)[0];
    if (latest && input.settlementVersion <= latest.settlementVersion) return false;
    if (latest?.analyzedAt) throw new Error(`Turn ${input.turnId} has already been analyzed; a compensating rebuild is required`);
    for (const previous of this.inputs.filter((item) => item.turnId === input.turnId && item.analyzedAt === null)) previous.analyzedAt = new Date();
    this.inputs.push(clone({ ...input, id: this.nextInputId++ }));
    return true;
  }
  async listPendingInputs(limit: number): Promise<AnalysisInput[]> {
    return clone(this.inputs.filter((item) => item.analyzedAt === null).sort((a, b) => a.occurredAt.getTime() - b.occurredAt.getTime()).slice(0, limit));
  }
  async listCandidateClusters(type: QueryCluster["clusterType"], projectScope: string | null, modulePathHash: string | null): Promise<QueryCluster[]> {
    return clone(this.clusters.filter((item) => item.clusterType === type && item.projectScope === projectScope && item.modulePathHash === modulePathHash && !["merged","retired"].includes(item.status)));
  }
  async createCluster(cluster: Omit<QueryCluster, "id">): Promise<QueryCluster> {
    const created = clone({ ...cluster, id: this.nextClusterId++ }); this.clusters.push(created); return clone(created);
  }
  async addMember(member: ClusterMember): Promise<boolean> {
    if (this.members.some((item) => item.analysisInputId === member.analysisInputId)) return false;
    this.members.push(clone(member)); return true;
  }
  async listRepresentativeQueries(clusterId: number, limit: number): Promise<string[]> {
    const cluster = this.clusters.find((item) => item.id === clusterId);
    if (!cluster || limit < 1) return [];
    const queries = [cluster.representativeQuery];
    for (const member of this.members.filter((item) => item.clusterId === clusterId)) {
      const query = this.inputs.find((input) => input.id === member.analysisInputId)?.queryText;
      if (query && !queries.includes(query)) queries.push(query);
      if (queries.length >= limit) break;
    }
    return clone(queries.slice(0, limit));
  }
  async listMemberVectors(clusterId: number): Promise<number[][]> {
    return clone(this.members.filter((item) => item.clusterId === clusterId && item.queryVector).map((item) => item.queryVector!));
  }
  async updateCentroid(clusterId: number, centroidVector: number[], embeddingModelVersion: string): Promise<void> {
    const cluster = this.clusters.find((item) => item.id === clusterId);
    if (cluster) { cluster.centroidVector = clone(centroidVector); cluster.embeddingModelVersion = embeddingModelVersion; }
  }
  async rebuildCentroid(clusterId: number, centroidVector: number[], embeddingModelVersion: string): Promise<void> {
    await this.updateCentroid(clusterId, centroidVector, embeddingModelVersion);
    for (const member of this.members) {
      if (member.clusterId === clusterId && member.queryVector) member.semanticSimilarity = cosineSimilarity(member.queryVector, centroidVector);
    }
  }
  async upsertScene(scene: ClusterScene): Promise<void> {
    const key = `${scene.clusterId}:${scene.sceneKey}`; const current = this.scenes.get(key);
    if (current) { current.sampleCount += 1; current.successCount += scene.succeeded ? 1 : 0; current.scene.occurredAt = scene.occurredAt; }
    else this.scenes.set(key, { scene: clone(scene), sampleCount: 1, successCount: scene.succeeded ? 1 : 0 });
  }
  async addCoverageGap(gap: CoverageGap): Promise<boolean> {
    if (this.gaps.some((item) => item.analysisInputId === gap.analysisInputId && item.attemptedSkillId === gap.attemptedSkillId)) return false;
    this.gaps.push(clone(gap)); return true;
  }
  async recalculateCluster(clusterId: number): Promise<QueryCluster> {
    const cluster = this.clusters.find((item) => item.id === clusterId); if (!cluster) throw new Error(`Cluster not found: ${clusterId}`);
    const members = this.members.filter((item) => item.clusterId === clusterId);
    const inputs = members.map((member) => this.inputs.find((input) => input.id === member.analysisInputId)!).filter(Boolean);
    cluster.sampleCount = members.filter((member) => member.thresholdEligible).length;
    cluster.distinctActorCount = new Set(inputs.map((input) => input.actorHash)).size;
    cluster.successCount = members.filter((member) => member.qualitySuccess).length;
    cluster.coverageGapCount = this.gaps.filter((gap) => gap.clusterId === clusterId).length;
    cluster.attemptedSkillCount = inputs.filter((input) => Boolean(input.attemptedSkillId)).length;
    cluster.semanticCohesion = members.length ? members.reduce((sum, item) => sum + item.semanticSimilarity, 0) / members.length : 0;
    cluster.inputCompleteness = inputs.length ? inputs.filter((input) => input.collectionTrust === "trusted" && (cluster.clusterType === "uncovered" || Boolean(input.modulePathHash))).length / inputs.length : 0;
    cluster.firstSeenAt = new Date(Math.min(...inputs.map((input) => input.occurredAt.getTime())));
    cluster.lastSeenAt = new Date(Math.max(...inputs.map((input) => input.occurredAt.getTime())));
    cluster.version += 1;
    return clone(cluster);
  }
  async mergeClusters(targetClusterId: number, sourceClusterId: number): Promise<void> {
    for (const member of this.members) if (member.clusterId === sourceClusterId) member.clusterId = targetClusterId;
    for (const gap of this.gaps) if (gap.clusterId === sourceClusterId) gap.clusterId = targetClusterId;
    for (const [key, sourceScene] of [...this.scenes.entries()]) {
      if (sourceScene.scene.clusterId !== sourceClusterId) continue;
      const targetKey = `${targetClusterId}:${sourceScene.scene.sceneKey}`;
      const targetScene = this.scenes.get(targetKey);
      if (targetScene) {
        targetScene.sampleCount += sourceScene.sampleCount;
        targetScene.successCount += sourceScene.successCount;
        if (sourceScene.scene.occurredAt > targetScene.scene.occurredAt) targetScene.scene.occurredAt = sourceScene.scene.occurredAt;
      } else {
        sourceScene.scene.clusterId = targetClusterId;
        this.scenes.set(targetKey, sourceScene);
      }
      this.scenes.delete(key);
    }
    const source = this.clusters.find((item) => item.id === sourceClusterId);
    if (source) { source.status = "merged"; source.mergedIntoClusterId = targetClusterId; }
  }
  async appendScore(_clusterId:number,_clusterVersion:number,_scoreType:string,_scoreValue:number|null,_reason:Record<string,unknown>): Promise<void> {}
  async handOffCandidate(clusterId: number, event: CandidateEvent): Promise<boolean> {
    if (this.outbox.some((item) => item.eventId === event.eventId || (item.clusterId === event.clusterId && item.clusterVersion === event.clusterVersion && item.candidateType === event.candidateType))) return false;
    const cluster = this.clusters.find((item) => item.id === clusterId); if (!cluster || !["observing","handed_off"].includes(cluster.status)) return false;
    cluster.status = "handed_off"; this.outbox.push(clone(event)); this.candidateDelivery.set(event.eventId, { status: "pending", attempts: 0, owner: null, leaseUntil: null, nextAttemptAt: new Date() }); return true;
  }
  async hasCandidate(clusterId: number, clusterVersion: number, candidateType: CandidateEvent["candidateType"]): Promise<boolean> { return this.outbox.some((item) => item.clusterId === clusterId && item.clusterVersion === clusterVersion && item.candidateType === candidateType); }
  async findLatestCandidate(clusterId: number): Promise<CandidateEvent | null> { return clone([...this.outbox].reverse().find((item) => item.clusterId === clusterId) ?? null); }
  async markAnalyzed(inputId: number, analyzedAt: Date): Promise<void> { const input = this.inputs.find((item) => item.id === inputId); if (input) input.analyzedAt = new Date(analyzedAt); }
  async listScenes(clusterId: number): Promise<Array<{ sceneType: string; sampleCount: number; successCount: number; riskLevel: string; toolPath: Array<{ projectId: string; moduleId: string | null; toolName: string; serviceVersionId: string | null; toolVersionId: string | null; operation: string | null }> }>> {
    return [...this.scenes.values()].filter((item) => item.scene.clusterId === clusterId).map((item) => ({ sceneType: item.scene.sceneType, sampleCount: item.sampleCount, successCount: item.successCount, riskLevel: item.scene.riskLevel, toolPath: clone(item.scene.toolPath) }));
  }
  async listOutbox(): Promise<CandidateEvent[]> { return clone(this.outbox); }
  async claimCandidateEvents(workerId: string, now: Date, leaseMs: number, limit: number): Promise<CandidateEvent[]> {
    const claimed: CandidateEvent[] = [];
    for (const event of this.outbox) {
      const state = this.candidateDelivery.get(event.eventId);
      if (!state || state.nextAttemptAt > now || (state.status === "delivering" && state.leaseUntil && state.leaseUntil > now) || ["delivered", "dead"].includes(state.status)) continue;
      state.status = "delivering"; state.owner = workerId; state.leaseUntil = new Date(now.getTime() + leaseMs); state.attempts++;
      claimed.push(clone(event)); if (claimed.length >= limit) break;
    }
    return claimed;
  }
  async markCandidateDelivered(eventId: string, workerId: string, _at: Date): Promise<boolean> { const state = this.candidateDelivery.get(eventId); if (!state || state.status !== "delivering" || state.owner !== workerId) return false; state.status = "delivered"; state.owner = null; state.leaseUntil = null; return true; }
  async markCandidateFailure(eventId: string, workerId: string, nextAttemptAt: Date, maxAttempts: number): Promise<boolean> { const state = this.candidateDelivery.get(eventId); if (!state || state.status !== "delivering" || state.owner !== workerId) return false; state.status = state.attempts >= maxAttempts ? "dead" : "pending"; state.owner = null; state.leaseUntil = null; state.nextAttemptAt = new Date(nextAttemptAt); return true; }
  async listClusters(): Promise<QueryCluster[]> { return clone(this.clusters); }
}

type Executor = Pool | PoolConnection;
const parseJson = <T>(value: unknown): T => typeof value === "string" ? JSON.parse(value) as T : value as T;
const toDate = (value: unknown): Date => value instanceof Date ? value : new Date(String(value));
const nullableDate = (value: unknown): Date | null => value === null ? null : toDate(value);

function inputFrom(row: RowDataPacket): AnalysisInput {
  return { id:Number(row.id),eventId:row.event_id,turnId:row.turn_id,settlementVersion:Number(row.settlement_version),actorHash:row.actor_hash,queryText:row.query_text,queryFingerprint:row.query_fingerprint,
    projectScope:row.project_scope,modulePathHash:row.module_path_hash,modulePath:row.module_path===null?null:parseJson<string[]>(row.module_path),calls:parseJson(row.calls),behaviorSignals:row.behavior_signals===null?null:parseJson(row.behavior_signals),
    settlementStatus:row.settlement_status,collectionTrust:row.collection_trust,attemptedSkillId:row.attempted_skill_id,attemptedSkillVersion:row.attempted_skill_version,occurredAt:toDate(row.occurred_at),analyzedAt:nullableDate(row.analyzed_at) };
}
function clusterFrom(row: RowDataPacket): QueryCluster {
  return { id:Number(row.id),clusterKey:row.cluster_key,clusterType:row.cluster_type,projectScope:row.project_scope,modulePathHash:row.module_path_hash,modulePath:row.module_path===null?null:parseJson<string[]>(row.module_path),
    representativeEventId:row.representative_event_id,representativeQuery:row.representative_query,status:row.status,mergedIntoClusterId:row.merged_into_cluster_id===null||row.merged_into_cluster_id===undefined?null:Number(row.merged_into_cluster_id),sampleCount:Number(row.sample_count),distinctActorCount:Number(row.distinct_actor_count),successCount:Number(row.success_count),
    coverageGapCount:Number(row.coverage_gap_count),attemptedSkillCount:Number(row.attempted_skill_count),semanticCohesion:Number(row.semantic_cohesion ?? 0),inputCompleteness:Number(row.input_completeness ?? 0),
    centroidVector:row.centroid_vector===null||row.centroid_vector===undefined?null:parseJson<number[]>(row.centroid_vector),embeddingModelVersion:row.embedding_model_version??null,
    firstSeenAt:toDate(row.first_seen_at),lastSeenAt:toDate(row.last_seen_at),version:Number(row.version) };
}

export class MySqlAnalysisRepository implements AnalysisRepository {
  constructor(private readonly executor: Executor, private readonly pool?: Pool, private readonly directTransaction = false) {}
  async transaction<T>(work: (repository: AnalysisRepository) => Promise<T>): Promise<T> {
    if (this.pool) { const connection=await this.pool.getConnection(); try { await connection.beginTransaction(); const result=await work(new MySqlAnalysisRepository(connection,undefined,true)); await connection.commit(); return result; } catch(error){await connection.rollback();throw error;} finally{connection.release();} }
    if (this.directTransaction) { const connection=this.executor as PoolConnection; await connection.beginTransaction(); try { const result=await work(this); await connection.commit(); return result; } catch(error){await connection.rollback();throw error;} }
    return work(this);
  }
  async withBatchLock<T>(work: (repository: AnalysisRepository) => Promise<T>): Promise<T | null> {
    if (!this.pool) return work(this);
    const connection=await this.pool.getConnection();
    try { const [[lock]]=await connection.query<RowDataPacket[]>("SELECT GET_LOCK('linkcli:l3-analysis-batch',0) acquired"); if (!lock || Number(lock.acquired)!==1) return null; return await work(new MySqlAnalysisRepository(this.pool,this.pool)); }
    finally { await connection.query("SELECT RELEASE_LOCK('linkcli:l3-analysis-batch')").catch(()=>undefined); connection.release(); }
  }
  async insertInput(input: AnalysisInput): Promise<boolean> {
    if (this.pool) return this.transaction((repository) => repository.insertInput(input));
    const [versions]=await this.executor.query<RowDataPacket[]>("SELECT event_id,settlement_version,analyzed_at FROM mcp_analysis_input WHERE turn_id=? ORDER BY settlement_version DESC LIMIT 1 FOR UPDATE",[input.turnId]);
    const latest=versions[0];
    if (latest && (latest.event_id===input.eventId || input.settlementVersion<=Number(latest.settlement_version))) return false;
    if (latest?.analyzed_at!==null && latest?.analyzed_at!==undefined) throw new Error(`Turn ${input.turnId} has already been analyzed; a compensating rebuild is required`);
    const [result]=await this.executor.execute<ResultSetHeader>(`INSERT IGNORE INTO mcp_analysis_input (event_id,turn_id,settlement_version,actor_hash,query_text,query_fingerprint,project_scope,module_path_hash,module_path,calls,behavior_signals,settlement_status,collection_trust,attempted_skill_id,attempted_skill_version,occurred_at,analyzed_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [input.eventId,input.turnId,input.settlementVersion,input.actorHash,input.queryText,input.queryFingerprint,input.projectScope,input.modulePathHash,input.modulePath?JSON.stringify(input.modulePath):null,JSON.stringify(input.calls),input.behaviorSignals?JSON.stringify(input.behaviorSignals):null,input.settlementStatus,input.collectionTrust,input.attemptedSkillId,input.attemptedSkillVersion,input.occurredAt,input.analyzedAt]);
    if(result.affectedRows===1)await this.executor.execute("UPDATE mcp_analysis_input SET analyzed_at=UTC_TIMESTAMP(6) WHERE turn_id=? AND settlement_version<? AND analyzed_at IS NULL",[input.turnId,input.settlementVersion]);
    return result.affectedRows===1;
  }
  async listPendingInputs(limit: number): Promise<AnalysisInput[]> { const [rows]=await this.executor.query<RowDataPacket[]>("SELECT * FROM mcp_analysis_input WHERE analyzed_at IS NULL ORDER BY occurred_at,id LIMIT ?",[limit]); return rows.map(inputFrom); }
  async listCandidateClusters(type: QueryCluster["clusterType"],projectScope:string|null,modulePathHash:string|null):Promise<QueryCluster[]>{const [rows]=await this.executor.query<RowDataPacket[]>(`SELECT c.*,i.query_text representative_query FROM mcp_query_cluster c JOIN mcp_analysis_input i ON i.event_id=c.representative_event_id WHERE c.cluster_type=? AND c.project_scope <=> ? AND c.module_path_hash <=> ? AND c.status NOT IN ('merged','retired')`,[type,projectScope,modulePathHash]);return rows.map(clusterFrom);}
  async createCluster(cluster:Omit<QueryCluster,"id">):Promise<QueryCluster>{const [result]=await this.executor.execute<ResultSetHeader>(`INSERT INTO mcp_query_cluster (cluster_key,cluster_type,project_scope,module_path_hash,module_path,representative_event_id,status,sample_count,distinct_actor_count,success_count,coverage_gap_count,attempted_skill_count,semantic_cohesion,input_completeness,centroid_vector,embedding_model_version,first_seen_at,last_seen_at,version) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,[cluster.clusterKey,cluster.clusterType,cluster.projectScope,cluster.modulePathHash,cluster.modulePath?JSON.stringify(cluster.modulePath):null,cluster.representativeEventId,cluster.status,cluster.sampleCount,cluster.distinctActorCount,cluster.successCount,cluster.coverageGapCount,cluster.attemptedSkillCount,cluster.semanticCohesion,cluster.inputCompleteness,cluster.centroidVector?JSON.stringify(cluster.centroidVector):null,cluster.embeddingModelVersion,cluster.firstSeenAt,cluster.lastSeenAt,cluster.version]);return{...cluster,id:result.insertId};}
  async addMember(member:ClusterMember):Promise<boolean>{const [result]=await this.executor.execute<ResultSetHeader>("UPDATE mcp_analysis_input SET cluster_id=?,semantic_similarity=?,query_vector=?,scene_type=?,threshold_eligible=?,quality_success=?,exclusion_reason=?,clustered_at=UTC_TIMESTAMP(6) WHERE id=? AND cluster_id IS NULL",[member.clusterId,member.semanticSimilarity,member.queryVector?JSON.stringify(member.queryVector):null,member.sceneType,member.thresholdEligible,member.qualitySuccess,member.exclusionReason,member.analysisInputId]);return result.affectedRows===1;}
  async listRepresentativeQueries(clusterId:number,limit:number):Promise<string[]>{
    if(limit<1)return[];
    const [rows]=await this.executor.query<RowDataPacket[]>(`SELECT i.query_text FROM mcp_analysis_input i JOIN mcp_query_cluster c ON c.id=i.cluster_id WHERE i.cluster_id=? ORDER BY (i.event_id=c.representative_event_id) DESC,i.clustered_at,i.id LIMIT ?`,[clusterId,limit*2]);
    return[...new Set(rows.map((row)=>String(row.query_text)))].slice(0,limit);
  }
  async listMemberVectors(clusterId:number):Promise<number[][]>{const [rows]=await this.executor.query<RowDataPacket[]>("SELECT query_vector FROM mcp_analysis_input WHERE cluster_id=? AND query_vector IS NOT NULL",[clusterId]);return rows.map((row)=>parseJson<number[]>(row.query_vector));}
  async updateCentroid(clusterId:number,centroidVector:number[],embeddingModelVersion:string):Promise<void>{
    await this.executor.execute("UPDATE mcp_query_cluster SET centroid_vector=?,embedding_model_version=? WHERE id=?",[JSON.stringify(centroidVector),embeddingModelVersion,clusterId]);
  }
  async rebuildCentroid(clusterId:number,centroidVector:number[],embeddingModelVersion:string):Promise<void>{
    await this.updateCentroid(clusterId,centroidVector,embeddingModelVersion);
    const [members]=await this.executor.query<RowDataPacket[]>("SELECT id,query_vector FROM mcp_analysis_input WHERE cluster_id=? AND query_vector IS NOT NULL",[clusterId]);
    for(const member of members){
      const similarity=cosineSimilarity(parseJson<number[]>(member.query_vector),centroidVector);
      await this.executor.execute("UPDATE mcp_analysis_input SET semantic_similarity=? WHERE id=?",[similarity,member.id]);
    }
  }
  async mergeClusters(targetClusterId:number,sourceClusterId:number):Promise<void>{
    await this.executor.execute("UPDATE mcp_analysis_input SET cluster_id=? WHERE cluster_id=?",[targetClusterId,sourceClusterId]);
    await this.executor.execute(`INSERT INTO mcp_query_cluster_scene (cluster_id,scene_key,scene_type,tool_path,risk_level,sample_count,success_count,flow_stability,first_seen_at,last_seen_at)
      SELECT ?,scene_key,scene_type,tool_path,risk_level,sample_count,success_count,flow_stability,first_seen_at,last_seen_at FROM mcp_query_cluster_scene WHERE cluster_id=?
      ON DUPLICATE KEY UPDATE flow_stability=(mcp_query_cluster_scene.success_count+VALUES(success_count))/(mcp_query_cluster_scene.sample_count+VALUES(sample_count)),sample_count=mcp_query_cluster_scene.sample_count+VALUES(sample_count),success_count=mcp_query_cluster_scene.success_count+VALUES(success_count),first_seen_at=LEAST(mcp_query_cluster_scene.first_seen_at,VALUES(first_seen_at)),last_seen_at=GREATEST(mcp_query_cluster_scene.last_seen_at,VALUES(last_seen_at))`,[targetClusterId,sourceClusterId]);
    await this.executor.execute("DELETE FROM mcp_query_cluster_scene WHERE cluster_id=?",[sourceClusterId]);
    await this.executor.execute("UPDATE mcp_query_cluster SET status='merged',merged_into_cluster_id=? WHERE id=?",[targetClusterId,sourceClusterId]);
  }
  async upsertScene(scene:ClusterScene):Promise<void>{const success=scene.succeeded?1:0;await this.executor.execute(`INSERT INTO mcp_query_cluster_scene (cluster_id,scene_key,scene_type,tool_path,risk_level,sample_count,success_count,flow_stability,first_seen_at,last_seen_at) VALUES (?,?,?,?,?,1,?,?,?,?) ON DUPLICATE KEY UPDATE sample_count=sample_count+1,success_count=success_count+VALUES(success_count),flow_stability=success_count/sample_count,last_seen_at=GREATEST(last_seen_at,VALUES(last_seen_at))`,[scene.clusterId,scene.sceneKey,scene.sceneType,JSON.stringify(scene.toolPath),scene.riskLevel,success,success,scene.occurredAt,scene.occurredAt]);}
  async addCoverageGap(gap:CoverageGap):Promise<boolean>{const [result]=await this.executor.execute<ResultSetHeader>("UPDATE mcp_analysis_input SET coverage_gap_type=?,coverage_gap_evidence=? WHERE id=? AND cluster_id=? AND attempted_skill_id=? AND coverage_gap_type IS NULL",[gap.gapType,JSON.stringify(gap.evidence),gap.analysisInputId,gap.clusterId,gap.attemptedSkillId]);return result.affectedRows===1;}
  async recalculateCluster(clusterId:number):Promise<QueryCluster>{await this.executor.execute(`UPDATE mcp_query_cluster c SET sample_count=(SELECT COUNT(*) FROM mcp_analysis_input i WHERE i.cluster_id=c.id AND i.threshold_eligible=1),distinct_actor_count=(SELECT COUNT(DISTINCT i.actor_hash) FROM mcp_analysis_input i WHERE i.cluster_id=c.id),success_count=(SELECT COUNT(*) FROM mcp_analysis_input i WHERE i.cluster_id=c.id AND i.quality_success=1),coverage_gap_count=(SELECT COUNT(*) FROM mcp_analysis_input i WHERE i.cluster_id=c.id AND i.coverage_gap_type IS NOT NULL),attempted_skill_count=(SELECT COUNT(*) FROM mcp_analysis_input i WHERE i.cluster_id=c.id AND i.attempted_skill_id IS NOT NULL),semantic_cohesion=(SELECT COALESCE(AVG(i.semantic_similarity),0) FROM mcp_analysis_input i WHERE i.cluster_id=c.id),input_completeness=(SELECT COALESCE(AVG(i.collection_trust='trusted' AND (c.cluster_type='uncovered' OR i.module_path_hash IS NOT NULL)),0) FROM mcp_analysis_input i WHERE i.cluster_id=c.id),first_seen_at=(SELECT MIN(i.occurred_at) FROM mcp_analysis_input i WHERE i.cluster_id=c.id),last_seen_at=(SELECT MAX(i.occurred_at) FROM mcp_analysis_input i WHERE i.cluster_id=c.id),version=version+1 WHERE c.id=?`,[clusterId]);const [rows]=await this.executor.query<RowDataPacket[]>(`SELECT c.*,i.query_text representative_query FROM mcp_query_cluster c JOIN mcp_analysis_input i ON i.event_id=c.representative_event_id WHERE c.id=?`,[clusterId]);if(!rows[0])throw new Error(`Cluster not found: ${clusterId}`);return clusterFrom(rows[0]);}
  async appendScore(clusterId:number,clusterVersion:number,scoreType:string,scoreValue:number|null,reason:Record<string,unknown>):Promise<void>{await this.executor.execute("INSERT INTO mcp_cluster_score_history (cluster_id,cluster_version,score_type,score_value,reason) VALUES (?,?,?,?,?)",[clusterId,clusterVersion,scoreType,scoreValue,JSON.stringify(reason)]);}
  async handOffCandidate(clusterId:number,event:CandidateEvent):Promise<boolean>{const [clusters]=await this.executor.query<RowDataPacket[]>("SELECT status FROM mcp_query_cluster WHERE id=? FOR UPDATE",[clusterId]);if(!clusters[0]||!["observing","handed_off"].includes(String(clusters[0].status)))return false;const [existing]=await this.executor.query<RowDataPacket[]>("SELECT id FROM mcp_l4_candidate_outbox WHERE cluster_id=? AND cluster_version=? AND candidate_type=? LIMIT 1",[clusterId,event.clusterVersion,event.candidateType]);if(existing[0])return false;if(clusters[0].status!=="handed_off")await this.executor.execute("UPDATE mcp_query_cluster SET status='handed_off' WHERE id=?",[clusterId]);await this.executor.execute("INSERT INTO mcp_l4_candidate_outbox (event_id,cluster_id,cluster_version,candidate_type,payload) VALUES (?,?,?,?,?)",[event.eventId,event.clusterId,event.clusterVersion,event.candidateType,JSON.stringify(event.payload)]);return true;}
  async hasCandidate(clusterId:number,clusterVersion:number,candidateType:CandidateEvent["candidateType"]):Promise<boolean>{const [rows]=await this.executor.query<RowDataPacket[]>("SELECT 1 FROM mcp_l4_candidate_outbox WHERE cluster_id=? AND cluster_version=? AND candidate_type=? LIMIT 1",[clusterId,clusterVersion,candidateType]);return rows.length>0;}
  async findLatestCandidate(clusterId:number):Promise<CandidateEvent|null>{const [rows]=await this.executor.query<RowDataPacket[]>("SELECT event_id,cluster_id,cluster_version,candidate_type,payload FROM mcp_l4_candidate_outbox WHERE cluster_id=? ORDER BY id DESC LIMIT 1",[clusterId]);const row=rows[0];return row?{eventId:row.event_id,clusterId:Number(row.cluster_id),clusterVersion:Number(row.cluster_version),candidateType:row.candidate_type,payload:parseJson(row.payload)}:null;}
  async markAnalyzed(inputId:number,analyzedAt:Date):Promise<void>{await this.executor.execute("UPDATE mcp_analysis_input SET analyzed_at=? WHERE id=? AND analyzed_at IS NULL",[analyzedAt,inputId]);}
  async listScenes(clusterId:number):Promise<Array<{sceneType:string;sampleCount:number;successCount:number;riskLevel:string;toolPath:Array<{projectId:string;moduleId:string|null;toolName:string;serviceVersionId:string|null;toolVersionId:string|null;operation:string|null}>}>>{const [rows]=await this.executor.query<RowDataPacket[]>("SELECT scene_type,sample_count,success_count,risk_level,tool_path FROM mcp_query_cluster_scene WHERE cluster_id=? ORDER BY sample_count DESC",[clusterId]);return rows.map((row)=>({sceneType:row.scene_type,sampleCount:Number(row.sample_count),successCount:Number(row.success_count),riskLevel:row.risk_level,toolPath:parseJson(row.tool_path)}));}
  async listOutbox():Promise<CandidateEvent[]>{const [rows]=await this.executor.query<RowDataPacket[]>("SELECT event_id,cluster_id,cluster_version,candidate_type,payload FROM mcp_l4_candidate_outbox ORDER BY id");return rows.map((row)=>({eventId:row.event_id,clusterId:Number(row.cluster_id),clusterVersion:Number(row.cluster_version),candidateType:row.candidate_type,payload:parseJson(row.payload)}));}
  async claimCandidateEvents(workerId:string,now:Date,leaseMs:number,limit:number):Promise<CandidateEvent[]>{if(this.pool)return this.transaction((repository)=>repository.claimCandidateEvents(workerId,now,leaseMs,limit));const [rows]=await this.executor.query<RowDataPacket[]>("SELECT event_id,cluster_id,cluster_version,candidate_type,payload FROM mcp_l4_candidate_outbox WHERE next_attempt_at<=? AND (status='pending' OR (status='delivering' AND (lease_until IS NULL OR lease_until<=?))) ORDER BY id LIMIT ? FOR UPDATE SKIP LOCKED",[now,now,limit]);if(!rows.length)return[];const ids=rows.map((row)=>row.event_id);await this.executor.execute(`UPDATE mcp_l4_candidate_outbox SET status='delivering',lease_owner=?,lease_until=?,attempt_count=attempt_count+1,updated_at=? WHERE event_id IN (${ids.map(()=>"?").join(",")})`,[workerId,new Date(now.getTime()+leaseMs),now,...ids]);return rows.map((row)=>({eventId:row.event_id,clusterId:Number(row.cluster_id),clusterVersion:Number(row.clusterVersion??row.cluster_version),candidateType:row.candidate_type,payload:parseJson(row.payload)}));}
  async markCandidateDelivered(eventId:string,workerId:string,at:Date):Promise<boolean>{const [result]=await this.executor.execute<ResultSetHeader>("UPDATE mcp_l4_candidate_outbox SET status='delivered',delivered_at=?,lease_owner=NULL,lease_until=NULL,updated_at=? WHERE event_id=? AND status='delivering' AND lease_owner=?",[at,at,eventId,workerId]);return result.affectedRows===1;}
  async markCandidateFailure(eventId:string,workerId:string,nextAttemptAt:Date,maxAttempts:number):Promise<boolean>{const [result]=await this.executor.execute<ResultSetHeader>("UPDATE mcp_l4_candidate_outbox SET status=IF(attempt_count>=?,'dead','pending'),next_attempt_at=?,lease_owner=NULL,lease_until=NULL,last_error_code='L4_CANDIDATE_DELIVERY_FAILED',updated_at=CURRENT_TIMESTAMP(6) WHERE event_id=? AND status='delivering' AND lease_owner=?",[maxAttempts,nextAttemptAt,eventId,workerId]);return result.affectedRows===1;}
  async listClusters():Promise<QueryCluster[]>{const [rows]=await this.executor.query<RowDataPacket[]>(`SELECT c.*,i.query_text representative_query FROM mcp_query_cluster c JOIN mcp_analysis_input i ON i.event_id=c.representative_event_id ORDER BY c.id`);return rows.map(clusterFrom);}
}
