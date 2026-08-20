import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { AnalysisBatchService } from "../src/analysis/batch-service.js";
import { AnalysisBatchScheduler } from "../src/analysis/batch-scheduler.js";
import { DeterministicFallbackEmbeddingProvider, type EmbeddingProvider } from "../src/analysis/embedding-provider.js";
import { NewClusterOnlyJudge, type ClusterJudge, type ClusterMergeDecision, type QueryAssignmentDecision } from "../src/analysis/cluster-judge.js";
import { AnalysisInputConsumer, type SettledTurnInput } from "../src/analysis/input-consumer.js";
import { ClusterRebuildJob } from "../src/analysis/rebuild.js";
import { MemoryAnalysisRepository } from "../src/analysis/repository.js";
import { cosineSimilarity, modulePathOf, normalizeQuery } from "../src/analysis/similarity.js";
import { defaultClusterThresholds, type AnalysisCall, type AnalysisInput, type SkillCoverageResolver } from "../src/analysis/types.js";

const actor = (value: string) => createHash("sha256").update(value).digest("hex");
const at = (day: number) => new Date(Date.UTC(2026, 7, day));
const call = (sequence: number, moduleId: string, toolName: string, operation: string): AnalysisCall => ({ sequence, projectId:"commerce",moduleId,toolName,operation,parameterKeys:["id"],outcome:"success" });
const turn = (eventId: string, actorId: string, queryText: string, calls: AnalysisCall[], occurredAt: Date, overrides: Partial<SettledTurnInput> = {}): SettledTurnInput => ({
  eventId,turnId:`turn-${eventId}`,settlementVersion:1,actorHash:actor(actorId),queryText,calls,settlementStatus:calls.length?"success":"zero_call",collectionTrust:"trusted",occurredAt,...overrides,
});
const permissive = { minimumSamples:3,minimumActors:3,minimumSpanMs:2*24*60*60*1_000,minimumInputCompleteness:1,minimumCohesion:0.8,minimumSuccessRate:0.9 };

const intentOf=(text:string):string=>{
  if(/审批权限|授权范围/u.test(text))return"permission";
  if(/物流轨迹|配送|签收/u.test(text))return"shipping";
  if(/发票/u.test(text))return"invoice";
  return"default";
};

class TestClusterJudge implements ClusterJudge {
  readonly modelVersion="test:llm-judge-v1";
  readonly candidateHandoffEnabled=true;
  readonly assignments:Array<{query:string;candidateIds:number[]}>=[];
  readonly merges:Array<[number,number]>=[];
  async assign(input:Parameters<ClusterJudge["assign"]>[0]):Promise<QueryAssignmentDecision>{
    this.assignments.push({query:input.query,candidateIds:input.candidates.map((item)=>item.clusterId)});
    const target=input.candidates.find((candidate)=>candidate.representativeQueries.some((query)=>intentOf(query)===intentOf(input.query)));
    return{clusterId:target?.clusterId??null,confidence:0.99,reason:target?"same test intent":"no matching test intent"};
  }
  async shouldMerge(input:Parameters<ClusterJudge["shouldMerge"]>[0]):Promise<ClusterMergeDecision>{
    this.merges.push([input.left.clusterId,input.right.clusterId]);
    const leftIntent=intentOf(input.left.representativeQueries[0]??"");const rightIntent=intentOf(input.right.representativeQueries[0]??"");
    return{sameDemand:leftIntent===rightIntent,confidence:0.99,reason:leftIntent===rightIntent?"same test intent":"different test intent"};
  }
}

class TestEmbeddingProvider implements EmbeddingProvider {
  constructor(
    readonly modelVersion = "test:semantic:4",
    private readonly vectorOf: (text: string) => number[] = (text) => {
      if (/审批权限/u.test(text)) return [0,1,0,0];
      if (/物流轨迹/u.test(text)) return [0,0,1,0];
      if (/发票/u.test(text)) return [0,0,0,1];
      return [1,0,0,0];
    },
  ) {}
  async embed(texts: string[]): Promise<number[][]> { return texts.map(this.vectorOf); }
}

class RecordingAnalysisRepository extends MemoryAnalysisRepository {
  readonly scores: Array<{ clusterId:number; scoreType:string; scoreValue:number|null; reason:Record<string,unknown> }> = [];
  override async appendScore(clusterId:number,_clusterVersion:number,scoreType:string,scoreValue:number|null,reason:Record<string,unknown>):Promise<void>{
    this.scores.push({clusterId,scoreType,scoreValue,reason});
  }
}

class OnlineCostAnalysisRepository extends MemoryAnalysisRepository {
  override async listMemberVectors(): Promise<number[][]> { throw new Error("online assignment must not scan all member vectors"); }
}

const embeddings = new TestEmbeddingProvider();
const judge = new TestClusterJudge();

describe("L3 scheduled Query clustering", () => {
  it("normalizes without deleting operation words and keeps module ordering", () => {
    expect(normalizeQuery("请查询用户信息，然后删除订单 123456")).toBe("请查询用户信息,然后删除订单 123456");
    expect(cosineSimilarity([1,0], [1,0])).toBe(1);
    expect(modulePathOf([call(1,"user","lookup","query"),call(2,"user","detail","query"),call(3,"order","delete","delete")]).modulePath).toEqual(["user","order"]);
  });

  it("treats a turn with any missing module mapping as uncovered", () => {
    const missingModule = { ...call(2,"order","query","query"), moduleId:undefined };
    expect(modulePathOf([call(1,"user","lookup","query"),missingModule])).toEqual({projectScope:null,modulePath:null,modulePathHash:null});
  });

  it("keeps project and module association in the candidate bucket hash", () => {
    const scopedCall=(sequence:number,projectId:string,moduleId:string):AnalysisCall=>({ ...call(sequence,moduleId,"query","query"),projectId });
    const first=modulePathOf([scopedCall(1,"p1","user"),scopedCall(2,"p2","order"),scopedCall(3,"p1","user")]);
    const second=modulePathOf([scopedCall(1,"p1","user"),scopedCall(2,"p1","order"),scopedCall(3,"p2","user")]);
    expect(first.modulePath).toEqual(second.modulePath);
    expect(first.modulePathHash).not.toBe(second.modulePathHash);
    expect(modulePathOf([scopedCall(1,"p1","user"),scopedCall(2,"p2","user")]).modulePath).toEqual(["user","user"]);
  });

  it("does not cluster on ingestion and groups query/update/delete as scenes in one scheduled batch", async () => {
    const repository=new MemoryAnalysisRepository(); const consumer=new AnalysisInputConsumer(repository);
    await consumer.accept(turn("e1","a1","查询用户信息后查询订单",[call(1,"user","lookup","query"),call(2,"order","query","query")],at(1)));
    await consumer.accept(turn("e2","a2","查询用户信息后修改订单",[call(1,"user","lookup","query"),call(2,"order","update","update")],at(2)));
    await consumer.accept(turn("e3","a3","查询用户信息后删除订单",[call(1,"user","lookup","query"),call(2,"order","delete","delete")],at(3)));
    expect(await repository.listClusters()).toEqual([]);
    const result=await new AnalysisBatchService(repository,embeddings,judge,permissive).runBatch(100,at(4));
    expect(result).toMatchObject({locked:true,read:3,analyzed:3,candidates:1});
    const clusters=await repository.listClusters();
    expect(clusters).toHaveLength(1); expect(clusters[0]).toMatchObject({modulePath:["user","order"],sampleCount:3,distinctActorCount:3,status:"handed_off"});
    expect((await repository.listScenes(clusters[0]!.id)).map((scene)=>scene.sceneType).sort()).toEqual(["query → delete","query → query","query → update"]);
    expect((await repository.listOutbox())[0]).toMatchObject({candidateType:"new_skill",payload:{modulePath:["user","order"],sampleCount:3}});
  });

  it("keeps a different module path in a separate cluster", async () => {
    const repository=new MemoryAnalysisRepository(); const consumer=new AnalysisInputConsumer(repository);
    await consumer.accept(turn("order","a1","查询用户信息后查询订单",[call(1,"user","lookup","query"),call(2,"order","query","query")],at(1)));
    await consumer.accept(turn("asset","a2","查询用户信息后查询资产",[call(1,"user","lookup","query"),call(2,"asset","query","query")],at(1)));
    await new AnalysisBatchService(repository,embeddings,judge,{minimumSamples:99}).runBatch();
    expect((await repository.listClusters()).map((cluster)=>cluster.modulePath)).toEqual([["user","order"],["user","asset"]]);
  });

  it("does not merge unrelated goals merely because the module path is the same", async () => {
    const repository=new MemoryAnalysisRepository(); const consumer=new AnalysisInputConsumer(repository);
    await consumer.accept(turn("permission","a1","检查用户是否有订单审批权限",[call(1,"user","lookup","query"),call(2,"order","permission","query")],at(1)));
    await consumer.accept(turn("shipping","a2","查看用户订单的物流轨迹",[call(1,"user","lookup","query"),call(2,"order","shipping","query")],at(1)));
    await new AnalysisBatchService(repository,embeddings,judge,{minimumSamples:99}).runBatch();
    expect(await repository.listClusters()).toHaveLength(2);
  });

  it("uses embedding only for Top-K recall and honors the Judge selection instead of the nearest centroid", async () => {
    const vectorByText:Record<string,number[]>={"类别甲":[1,0],"类别乙":[0.9,0.1],"类别丙":[0,1],"待归类":[0.99,0.01]};
    const provider=new TestEmbeddingProvider("test:top-k:2",(text)=>vectorByText[text]??[0,0]);
    let recalled:number[]=[];
    const selectingJudge:ClusterJudge={modelVersion:"test:top-k-judge",async assign(input){
      if(input.query!=="待归类")return{clusterId:null,confidence:1,reason:"seed category"};
      recalled=input.candidates.map((item)=>item.clusterId);
      return{clusterId:input.candidates[1]?.clusterId??null,confidence:0.9,reason:"second recalled category is the same intent"};
    },async shouldMerge(){return{sameDemand:false,confidence:1,reason:"not used"};}};
    const repository=new MemoryAnalysisRepository();const consumer=new AnalysisInputConsumer(repository);
    for(const [index,query] of ["类别甲","类别乙","类别丙","待归类"].entries())await consumer.accept(turn(`top-${index}`,`actor-${index}`,query,[call(1,"order","query","query")],at(index+1)));
    await new AnalysisBatchService(repository,provider,selectingJudge,{minimumSamples:99},undefined,false,{recallTopK:2,representativeQueryLimit:1}).runBatch();
    expect(recalled).toHaveLength(2);
    expect((await repository.listClusters()).filter((cluster)=>cluster.sampleCount===2)).toHaveLength(1);
  });

  it("creates a new category when the Judge rejects every recalled candidate", async () => {
    const rejectingJudge:ClusterJudge={modelVersion:"test:reject",async assign(){return{clusterId:null,confidence:0.95,reason:"different business goal"};},async shouldMerge(){return{sameDemand:false,confidence:0.95,reason:"different business goal"};}};
    const repository=new MemoryAnalysisRepository();const consumer=new AnalysisInputConsumer(repository);
    await consumer.accept(turn("reject-1","a1","订单权限审核",[call(1,"order","query","query")],at(1)));
    await consumer.accept(turn("reject-2","a2","订单物流跟踪",[call(1,"order","query","query")],at(2)));
    await new AnalysisBatchService(repository,embeddings,rejectingJudge,{minimumSamples:99}).runBatch();
    expect((await repository.listClusters()).filter((cluster)=>cluster.status==="observing")).toHaveLength(2);
  });

  it("skips the Judge for an exact normalized Query fingerprint", async () => {
    let judgeCalls=0;
    const recordingJudge:ClusterJudge={modelVersion:"test:exact",async assign(){judgeCalls+=1;return{clusterId:null,confidence:0,reason:"must not run"};},async shouldMerge(){return{sameDemand:false,confidence:1,reason:"not used"};}};
    const repository=new MemoryAnalysisRepository();const consumer=new AnalysisInputConsumer(repository);
    await consumer.accept(turn("exact-1","a1","查询订单 123456",[call(1,"order","query","query")],at(1)));
    await consumer.accept(turn("exact-2","a2","查询订单 654321",[call(1,"order","query","query")],at(2)));
    await new AnalysisBatchService(repository,embeddings,recordingJudge,{minimumSamples:99}).runBatch();
    expect(judgeCalls).toBe(0);expect(await repository.listClusters()).toHaveLength(1);
  });

  it("rejects an out-of-Top-K Judge decision and leaves that input pending", async () => {
    const invalidJudge:ClusterJudge={modelVersion:"test:invalid",async assign(){return{clusterId:999_999,confidence:1,reason:"invalid id"};},async shouldMerge(){return{sameDemand:false,confidence:1,reason:"not used"};}};
    const repository=new MemoryAnalysisRepository();const consumer=new AnalysisInputConsumer(repository);
    await consumer.accept(turn("invalid-1","a1","第一条订单需求",[call(1,"order","query","query")],at(1)));
    await consumer.accept(turn("invalid-2","a2","第二条订单需求",[call(1,"order","query","query")],at(2)));
    expect(await new AnalysisBatchService(repository,embeddings,invalidJudge,{minimumSamples:99}).runBatch()).toMatchObject({read:2,analyzed:1,failed:1});
    expect(await repository.listClusters()).toHaveLength(1);
    expect(await new AnalysisBatchService(repository,embeddings,invalidJudge,{minimumSamples:99}).runBatch()).toMatchObject({read:1,failed:1});
  });

  it("clusters zero-call queries into uncovered demand without inventing modules", async () => {
    const repository=new MemoryAnalysisRepository(); const consumer=new AnalysisInputConsumer(repository);
    for (const [index,day] of [1,2,3].entries()) await consumer.accept(turn(`u${index}`,`a${index}`,"查询发票开具进度",[],at(day)));
    const result=await new AnalysisBatchService(repository,embeddings,judge,permissive).runBatch();
    expect(result.candidates).toBe(1);
    expect((await repository.listClusters())[0]).toMatchObject({clusterType:"uncovered",modulePath:null});
    expect((await repository.listOutbox())[0]?.candidateType).toBe("uncovered_demand");
  });

  it("uses attempted Skill only for coverage gaps, not as the cluster key", async () => {
    const repository=new MemoryAnalysisRepository(); const consumer=new AnalysisInputConsumer(repository);
    const resolver:SkillCoverageResolver={async evaluate(input:AnalysisInput){return input.calls.some((item)=>item.operation==="delete")?{covered:false,gapType:"partial_coverage",evidence:{missingScene:"delete"}}:{covered:true};}};
    await consumer.accept(turn("g1","a1","查询用户信息后查询订单",[call(1,"user","lookup","query"),call(2,"order","query","query")],at(1),{attemptedSkillId:"user-order-skill"}));
    await consumer.accept(turn("g2","a2","查询用户信息后删除订单",[call(1,"user","lookup","query"),call(2,"order","delete","delete")],at(2),{attemptedSkillId:"user-order-skill"}));
    const result=await new AnalysisBatchService(repository,embeddings,judge,{...permissive,minimumSamples:2,minimumActors:2,minimumSpanMs:0,minimumCoverageGapCount:1},resolver).runBatch();
    expect(result.candidates).toBe(1); expect(await repository.listClusters()).toHaveLength(1);
    expect((await repository.listOutbox())[0]).toMatchObject({candidateType:"expand_skill",payload:{coverageGapCount:1}});
  });

  it("hands off an expansion when a handed-off new Skill later develops a coverage gap", async () => {
    const repository=new MemoryAnalysisRepository(); const consumer=new AnalysisInputConsumer(repository);
    const resolver:SkillCoverageResolver={async evaluate(){return{covered:false,gapType:"partial_coverage"};}};
    const thresholds={...permissive,minimumSamples:1,minimumActors:1,minimumSpanMs:0,minimumCohesion:0,minimumSuccessRate:0,minimumCoverageGapCount:1,minimumCoverageGapRatio:1};
    await consumer.accept(turn("initial","a1","查询用户信息后查询订单",[call(1,"user","lookup","query"),call(2,"order","query","query")],at(1)));
    expect((await new AnalysisBatchService(repository,embeddings,judge,thresholds,resolver).runBatch()).candidates).toBe(1);
    await consumer.accept(turn("gap","a2","查询用户信息后删除订单",[call(1,"user","lookup","query"),call(2,"order","delete","delete")],at(2),{attemptedSkillId:"user-order-skill"}));
    expect((await new AnalysisBatchService(repository,embeddings,judge,thresholds,resolver).runBatch()).candidates).toBe(1);
    expect((await repository.listOutbox()).map((event)=>event.candidateType)).toEqual(["new_skill","expand_skill"]);
  });

  it("does not emit the same candidate type for every version while the cluster remains handed off", async () => {
    const repository=new MemoryAnalysisRepository();const consumer=new AnalysisInputConsumer(repository);
    const thresholds={...permissive,minimumSamples:1,minimumActors:1,minimumSpanMs:0,minimumSuccessRate:0};
    await consumer.accept(turn("candidate-v1","a1","查询订单",[call(1,"order","query","query")],at(1)));
    expect((await new AnalysisBatchService(repository,embeddings,judge,thresholds).runBatch()).candidates).toBe(1);
    await consumer.accept(turn("candidate-v2","a2","查询订单",[call(1,"order","query","query")],at(2)));
    expect((await new AnalysisBatchService(repository,embeddings,judge,thresholds).runBatch()).candidates).toBe(0);
    expect((await repository.listOutbox()).map(event=>[event.clusterVersion,event.candidateType])).toEqual([[1,"new_skill"]]);
  });

  it("updates the online centroid without scanning every member vector", async () => {
    const repository=new OnlineCostAnalysisRepository();const consumer=new AnalysisInputConsumer(repository);
    await consumer.accept(turn("cost-1","a1","查询订单",[call(1,"order","query","query")],at(1)));
    await consumer.accept(turn("cost-2","a2","查询订单",[call(1,"order","query","query")],at(2)));
    expect(await new AnalysisBatchService(repository,embeddings,judge,{minimumSamples:99}).runBatch()).toMatchObject({analyzed:2,failed:0});
  });

  it("rolls back a failed input and continues the rest of the batch", async () => {
    const repository=new MemoryAnalysisRepository(); const consumer=new AnalysisInputConsumer(repository);
    const resolver:SkillCoverageResolver={async evaluate(input){if(input.eventId==="poison")throw new Error("coverage metadata unavailable");return{covered:true};}};
    await consumer.accept(turn("poison","a1","查询订单",[call(1,"order","query","query")],at(1),{attemptedSkillId:"order-skill"}));
    await consumer.accept(turn("healthy","a2","查询订单",[call(1,"order","query","query")],at(2)));
    const service=new AnalysisBatchService(repository,embeddings,judge,{minimumSamples:99},resolver);
    expect(await service.runBatch()).toMatchObject({read:2,analyzed:1,failed:1});
    expect((await repository.listClusters())[0]).toMatchObject({sampleCount:1,representativeEventId:"healthy"});
    expect(await service.runBatch()).toMatchObject({read:1,analyzed:0,failed:1});
  });

  it("reports isolated input failures through the scheduler without failing the completed batch", async () => {
    const repository=new MemoryAnalysisRepository(); const consumer=new AnalysisInputConsumer(repository);
    await consumer.accept(turn("poison-report","a1","查询订单",[call(1,"order","query","query")],at(1),{attemptedSkillId:"order-skill"}));
    const errors:unknown[]=[];
    const service=new AnalysisBatchService(repository,embeddings,judge,{minimumSamples:99},{async evaluate(){throw new Error("coverage metadata unavailable");}});
    const result=await new AnalysisBatchScheduler(service,60_000,100,(error)=>errors.push(error)).runOnce();
    expect(result).toMatchObject({read:1,analyzed:0,failed:1});
    expect(errors).toHaveLength(1);
  });

  it("does not generate a new candidate when the existing Skill already covers the class", async () => {
    const repository=new MemoryAnalysisRepository(); const consumer=new AnalysisInputConsumer(repository);
    const resolver:SkillCoverageResolver={async evaluate(){return{covered:true};}};
    for(const [index,day] of [1,2,3].entries())await consumer.accept(turn(`covered-${index}`,`actor-${index}`,"查询用户信息后查询订单",[call(1,"user","lookup","query"),call(2,"order","query","query")],at(day),{attemptedSkillId:"user-order-skill"}));
    const result=await new AnalysisBatchService(repository,embeddings,judge,permissive,resolver).runBatch();
    expect(result.candidates).toBe(0); expect(await repository.listOutbox()).toEqual([]);
  });

  it("is idempotent and excludes untrusted input from clustering", async () => {
    const repository=new MemoryAnalysisRepository(); const consumer=new AnalysisInputConsumer(repository);
    const input=turn("same","a1","查询订单",[call(1,"order","query","query")],at(1));
    expect(await consumer.accept(input)).toBe(true); expect(await consumer.accept(input)).toBe(false);
    await consumer.accept(turn("suspect","a2","查询订单",[call(1,"order","query","query")],at(1),{collectionTrust:"suspect"}));
    const first=await new AnalysisBatchService(repository,embeddings,judge,{minimumSamples:99}).runBatch(); const second=await new AnalysisBatchService(repository,embeddings,judge,{minimumSamples:99}).runBatch();
    expect(first).toMatchObject({read:2,analyzed:2,skipped:1}); expect(second.read).toBe(0);
    expect((await repository.listClusters())[0]?.sampleCount).toBe(1);
  });

  it("uses the latest settlement version before a batch and refuses silent revision after analysis", async () => {
    const repository=new MemoryAnalysisRepository(); const consumer=new AnalysisInputConsumer(repository);
    const first=turn("version-1","a1","查询订单",[call(1,"order","query","query")],at(1),{turnId:"versioned-turn",settlementVersion:1});
    const second=turn("version-2","a1","查询用户信息后查询订单",[call(1,"user","lookup","query"),call(2,"order","query","query")],at(1),{turnId:"versioned-turn",settlementVersion:2});
    await consumer.accept(first); await consumer.accept(second);
    expect((await new AnalysisBatchService(repository,embeddings,judge,{minimumSamples:99}).runBatch()).read).toBe(1);
    expect((await repository.listClusters())[0]?.modulePath).toEqual(["user","order"]);
    await expect(consumer.accept({...second,eventId:"version-3",settlementVersion:3})).rejects.toThrow(/compensating rebuild/);
  });

  it("allows only one concurrent batch to hold the analysis lock", async () => {
    const repository=new MemoryAnalysisRepository(); const service=new AnalysisBatchService(repository,embeddings,judge);
    const results=await Promise.all([service.runBatch(),service.runBatch()]);
    expect(results.map((result)=>result.locked).sort()).toEqual([false,true]);
  });

  it("does not treat a successful response with retry behavior as quality success", async () => {
    const repository=new MemoryAnalysisRepository(); const consumer=new AnalysisInputConsumer(repository);
    for(const [index,day] of [1,2,3].entries())await consumer.accept(turn(`retry-${index}`,`retry-actor-${index}`,"查询用户信息后查询订单",[call(1,"user","lookup","query"),call(2,"order","query","query")],at(day),index===0?{behaviorSignals:{retried:true}}:{}));
    const result=await new AnalysisBatchService(repository,embeddings,judge,permissive).runBatch();
    expect(result.candidates).toBe(0); expect((await repository.listClusters())[0]).toMatchObject({sampleCount:3,successCount:2});
  });

  it("clusters semantic paraphrases even when their wording differs", async () => {
    const repository=new MemoryAnalysisRepository(); const consumer=new AnalysisInputConsumer(repository);
    await consumer.accept(turn("semantic-1","a1","帮我看看客户最近买了什么",[call(1,"user","lookup","query"),call(2,"order","query","query")],at(1)));
    await consumer.accept(turn("semantic-2","a2","检索该用户的历史订单记录",[call(1,"user","lookup","query"),call(2,"order","query","query")],at(2)));
    await new AnalysisBatchService(repository,embeddings,judge,{minimumSamples:99}).runBatch();
    expect(await repository.listClusters()).toHaveLength(1);
  });

  it("keeps clusters from different embedding model versions isolated", async () => {
    const repository=new MemoryAnalysisRepository(); const consumer=new AnalysisInputConsumer(repository);
    await consumer.accept(turn("model-v1","a1","查询订单",[call(1,"order","query","query")],at(1)));
    await new AnalysisBatchService(repository,new TestEmbeddingProvider("test:model-v1:4"),judge,{minimumSamples:99}).runBatch();
    await consumer.accept(turn("model-v2","a2","查询订单",[call(1,"order","query","query")],at(2)));
    await new AnalysisBatchService(repository,new TestEmbeddingProvider("test:model-v2:4"),judge,{minimumSamples:99}).runBatch();
    expect((await repository.listClusters()).map((cluster)=>cluster.embeddingModelVersion)).toEqual(["test:model-v1:4","test:model-v2:4"]);
  });

  it("merges recalled observing clusters only when the Judge agrees", async () => {
    const provider=new TestEmbeddingProvider("test:merge:2",(text)=>text.includes("第一种")?[1,0]:[0.8,0.6]);
    const mergeJudge:ClusterJudge={modelVersion:"test:merge-judge",async assign(){return{clusterId:null,confidence:1,reason:"force fragments"};},async shouldMerge(){return{sameDemand:true,confidence:1,reason:"same business demand"};}};
    const repository=new MemoryAnalysisRepository(); const consumer=new AnalysisInputConsumer(repository);
    await consumer.accept(turn("merge-1","a1","第一种订单查询说法",[call(1,"order","query","query")],at(1)));
    await consumer.accept(turn("merge-2","a2","第二种订单查询表达",[call(1,"order","query","query")],at(2)));
    await new AnalysisBatchService(repository,provider,mergeJudge,{minimumSamples:99}).runBatch();
    expect((await repository.listClusters()).filter((cluster)=>cluster.status==="observing")).toHaveLength(2);
    const rebuild=new ClusterRebuildJob(repository,mergeJudge,{...defaultClusterThresholds});
    expect(await rebuild.runOnce()).toMatchObject({buckets:1,judgedPairs:1,merged:1});
    const clusters=await repository.listClusters();
    const active=clusters.filter((cluster)=>cluster.status==="observing");
    expect(active).toHaveLength(1);
    expect(active[0]?.semanticCohesion).toBeCloseTo(0.94868,4);
    expect(await repository.listScenes(active[0]!.id)).toEqual([expect.objectContaining({sampleCount:2,successCount:2})]);
    expect(clusters.filter((cluster)=>cluster.status==="merged")[0]?.mergedIntoClusterId).not.toBeNull();
  });

  it("keeps recalled category pairs separate when the Judge rejects the periodic merge", async () => {
    const noMergeJudge:ClusterJudge={modelVersion:"test:no-merge",async assign(){return{clusterId:null,confidence:1,reason:"force fragments"};},async shouldMerge(){return{sameDemand:false,confidence:0.98,reason:"different business goals"};}};
    const repository=new RecordingAnalysisRepository();const consumer=new AnalysisInputConsumer(repository);
    await consumer.accept(turn("no-merge-1","a1","订单权限审核",[call(1,"order","query","query")],at(1)));
    await consumer.accept(turn("no-merge-2","a2","订单物流跟踪",[call(1,"order","query","query")],at(2)));
    await new AnalysisBatchService(repository,embeddings,noMergeJudge,{minimumSamples:99}).runBatch();
    expect(await new ClusterRebuildJob(repository,noMergeJudge,defaultClusterThresholds).runOnce()).toMatchObject({judgedPairs:1,merged:0});
    expect((await repository.listClusters()).filter((cluster)=>cluster.status==="observing")).toHaveLength(2);
    expect(repository.scores).toContainEqual(expect.objectContaining({scoreType:"cluster_merge_judgement",reason:expect.objectContaining({sameDemand:false})}));
  });

  it("records a manual split review when a mature cluster has high variance", async () => {
    const provider=new TestEmbeddingProvider("test:variance:2",(text)=>text.includes("正向")?[1,0]:[-1,0]);
    const repository=new RecordingAnalysisRepository(); const consumer=new AnalysisInputConsumer(repository);
    await consumer.accept(turn("variance-1","a1","正向表达",[call(1,"order","query","query")],at(1)));
    await consumer.accept(turn("variance-2","a2","反向表达",[call(1,"order","query","query")],at(2)));
    await new AnalysisBatchService(repository,provider,judge,{minimumSamples:99},undefined,undefined,{minimumRecallSimilarity:-1}).runBatch();
    const rebuild=new ClusterRebuildJob(repository,judge,{...defaultClusterThresholds,minimumRebuildMembers:2,minimumCohesion:0.8});
    expect(await rebuild.runOnce()).toMatchObject({manualReview:1});
    expect(repository.scores).toContainEqual(expect.objectContaining({scoreType:"cluster_split_review",scoreValue:0,reason:expect.objectContaining({decision:"manual_review",memberCount:2})}));
  });

  it("never hands fallback word-overlap clusters to L4", async () => {
    const repository=new MemoryAnalysisRepository(); const consumer=new AnalysisInputConsumer(repository);
    for(const [index,day] of [1,2,3].entries())await consumer.accept(turn(`shadow-${index}`,`shadow-actor-${index}`,"查询订单",[call(1,"order","query","query")],at(day)));
    const result=await new AnalysisBatchService(repository,new DeterministicFallbackEmbeddingProvider(),judge,permissive).runBatch();
    expect(result.candidates).toBe(0);
    expect(await repository.listOutbox()).toEqual([]);
  });

  it("keeps semantic clusters in shadow mode until handoff is explicitly enabled", async () => {
    const repository=new MemoryAnalysisRepository(); const consumer=new AnalysisInputConsumer(repository);
    for(const [index,day] of [1,2,3].entries())await consumer.accept(turn(`semantic-shadow-${index}`,`semantic-shadow-actor-${index}`,"查询订单",[call(1,"order","query","query")],at(day)));
    const result=await new AnalysisBatchService(repository,embeddings,judge,permissive,undefined,false).runBatch();
    expect(result.candidates).toBe(0);
    expect((await repository.listClusters())[0]).toMatchObject({sampleCount:3,status:"observing"});
    expect(await repository.listOutbox()).toEqual([]);
  });

  it("never hands categories to L4 when no real LLM Judge is configured", async () => {
    const repository=new MemoryAnalysisRepository();const consumer=new AnalysisInputConsumer(repository);
    for(const [index,day] of [1,2,3].entries())await consumer.accept(turn(`no-judge-${index}`,`actor-${index}`,"查询订单",[call(1,"order","query","query")],at(day)));
    const result=await new AnalysisBatchService(repository,embeddings,new NewClusterOnlyJudge(),permissive,undefined,true).runBatch();
    expect(result.candidates).toBe(0);expect(await repository.listOutbox()).toEqual([]);
  });
});
