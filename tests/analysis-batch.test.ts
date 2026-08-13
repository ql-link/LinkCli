import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { AnalysisBatchService } from "../src/analysis/batch-service.js";
import { AnalysisBatchScheduler } from "../src/analysis/batch-scheduler.js";
import { AnalysisInputConsumer, type SettledTurnInput } from "../src/analysis/input-consumer.js";
import { MemoryAnalysisRepository } from "../src/analysis/repository.js";
import { modulePathOf, normalizeQuery, querySimilarity } from "../src/analysis/similarity.js";
import type { AnalysisCall, AnalysisInput, SkillCoverageResolver } from "../src/analysis/types.js";

const actor = (value: string) => createHash("sha256").update(value).digest("hex");
const at = (day: number) => new Date(Date.UTC(2026, 7, day));
const call = (sequence: number, moduleId: string, toolName: string, operation: string): AnalysisCall => ({ sequence, projectId:"commerce",moduleId,toolName,operation,parameterKeys:["id"],outcome:"success" });
const turn = (eventId: string, actorId: string, queryText: string, calls: AnalysisCall[], occurredAt: Date, overrides: Partial<SettledTurnInput> = {}): SettledTurnInput => ({
  eventId,turnId:`turn-${eventId}`,settlementVersion:1,actorHash:actor(actorId),queryText,calls,settlementStatus:calls.length?"success":"zero_call",collectionTrust:"trusted",occurredAt,...overrides,
});
const permissive = { minimumSamples:3,minimumActors:3,minimumSpanMs:2*24*60*60*1_000,minimumInputCompleteness:1,minimumCohesion:0.8,minimumSuccessRate:0.9,joinSimilarity:0.8 };

describe("L3 scheduled Query clustering", () => {
  it("removes operation words while preserving the business objects", () => {
    expect(normalizeQuery("请查询用户信息，然后删除订单 123456")).toBe("用户信息订单");
    expect(querySimilarity("查询用户信息后查询订单", "查询用户信息后删除订单")).toBe(1);
    expect(modulePathOf([call(1,"user","lookup","query"),call(2,"user","detail","query"),call(3,"order","delete","delete")]).modulePath).toEqual(["user","order"]);
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
    const result=await new AnalysisBatchService(repository,permissive).runBatch(100,at(4));
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
    await new AnalysisBatchService(repository,{minimumSamples:99}).runBatch();
    expect((await repository.listClusters()).map((cluster)=>cluster.modulePath)).toEqual([["user","order"],["user","asset"]]);
  });

  it("does not merge unrelated goals merely because the module path is the same", async () => {
    const repository=new MemoryAnalysisRepository(); const consumer=new AnalysisInputConsumer(repository);
    await consumer.accept(turn("permission","a1","检查用户是否有订单审批权限",[call(1,"user","lookup","query"),call(2,"order","permission","query")],at(1)));
    await consumer.accept(turn("shipping","a2","查看用户订单的物流轨迹",[call(1,"user","lookup","query"),call(2,"order","shipping","query")],at(1)));
    await new AnalysisBatchService(repository,{minimumSamples:99}).runBatch();
    expect(await repository.listClusters()).toHaveLength(2);
  });

  it("clusters zero-call queries into uncovered demand without inventing modules", async () => {
    const repository=new MemoryAnalysisRepository(); const consumer=new AnalysisInputConsumer(repository);
    for (const [index,day] of [1,2,3].entries()) await consumer.accept(turn(`u${index}`,`a${index}`,"查询发票开具进度",[],at(day)));
    const result=await new AnalysisBatchService(repository,permissive).runBatch();
    expect(result.candidates).toBe(1);
    expect((await repository.listClusters())[0]).toMatchObject({clusterType:"uncovered",modulePath:null});
    expect((await repository.listOutbox())[0]?.candidateType).toBe("uncovered_demand");
  });

  it("uses attempted Skill only for coverage gaps, not as the cluster key", async () => {
    const repository=new MemoryAnalysisRepository(); const consumer=new AnalysisInputConsumer(repository);
    const resolver:SkillCoverageResolver={async evaluate(input:AnalysisInput){return input.calls.some((item)=>item.operation==="delete")?{covered:false,gapType:"partial_coverage",evidence:{missingScene:"delete"}}:{covered:true};}};
    await consumer.accept(turn("g1","a1","查询用户信息后查询订单",[call(1,"user","lookup","query"),call(2,"order","query","query")],at(1),{attemptedSkillId:"user-order-skill"}));
    await consumer.accept(turn("g2","a2","查询用户信息后删除订单",[call(1,"user","lookup","query"),call(2,"order","delete","delete")],at(2),{attemptedSkillId:"user-order-skill"}));
    const result=await new AnalysisBatchService(repository,{...permissive,minimumSamples:2,minimumActors:2,minimumSpanMs:0,minimumCoverageGapCount:1},resolver).runBatch();
    expect(result.candidates).toBe(1); expect(await repository.listClusters()).toHaveLength(1);
    expect((await repository.listOutbox())[0]).toMatchObject({candidateType:"expand_skill",payload:{coverageGapCount:1}});
  });

  it("hands off an expansion when a handed-off new Skill later develops a coverage gap", async () => {
    const repository=new MemoryAnalysisRepository(); const consumer=new AnalysisInputConsumer(repository);
    const resolver:SkillCoverageResolver={async evaluate(){return{covered:false,gapType:"partial_coverage"};}};
    const thresholds={...permissive,minimumSamples:1,minimumActors:1,minimumSpanMs:0,minimumCohesion:0,minimumSuccessRate:0,minimumCoverageGapCount:1,minimumCoverageGapRatio:1};
    await consumer.accept(turn("initial","a1","查询用户信息后查询订单",[call(1,"user","lookup","query"),call(2,"order","query","query")],at(1)));
    expect((await new AnalysisBatchService(repository,thresholds,resolver).runBatch()).candidates).toBe(1);
    await consumer.accept(turn("gap","a2","查询用户信息后删除订单",[call(1,"user","lookup","query"),call(2,"order","delete","delete")],at(2),{attemptedSkillId:"user-order-skill"}));
    expect((await new AnalysisBatchService(repository,thresholds,resolver).runBatch()).candidates).toBe(1);
    expect((await repository.listOutbox()).map((event)=>event.candidateType)).toEqual(["new_skill","expand_skill"]);
  });

  it("rolls back a failed input and continues the rest of the batch", async () => {
    const repository=new MemoryAnalysisRepository(); const consumer=new AnalysisInputConsumer(repository);
    const resolver:SkillCoverageResolver={async evaluate(input){if(input.eventId==="poison")throw new Error("coverage metadata unavailable");return{covered:true};}};
    await consumer.accept(turn("poison","a1","查询订单",[call(1,"order","query","query")],at(1),{attemptedSkillId:"order-skill"}));
    await consumer.accept(turn("healthy","a2","查询订单",[call(1,"order","query","query")],at(2)));
    const service=new AnalysisBatchService(repository,{minimumSamples:99},resolver);
    expect(await service.runBatch()).toMatchObject({read:2,analyzed:1,failed:1});
    expect((await repository.listClusters())[0]).toMatchObject({sampleCount:1,representativeEventId:"healthy"});
    expect(await service.runBatch()).toMatchObject({read:1,analyzed:0,failed:1});
  });

  it("reports isolated input failures through the scheduler without failing the completed batch", async () => {
    const repository=new MemoryAnalysisRepository(); const consumer=new AnalysisInputConsumer(repository);
    await consumer.accept(turn("poison-report","a1","查询订单",[call(1,"order","query","query")],at(1),{attemptedSkillId:"order-skill"}));
    const errors:unknown[]=[];
    const service=new AnalysisBatchService(repository,{minimumSamples:99},{async evaluate(){throw new Error("coverage metadata unavailable");}});
    const result=await new AnalysisBatchScheduler(service,60_000,100,(error)=>errors.push(error)).runOnce();
    expect(result).toMatchObject({read:1,analyzed:0,failed:1});
    expect(errors).toHaveLength(1);
  });

  it("does not generate a new candidate when the existing Skill already covers the class", async () => {
    const repository=new MemoryAnalysisRepository(); const consumer=new AnalysisInputConsumer(repository);
    const resolver:SkillCoverageResolver={async evaluate(){return{covered:true};}};
    for(const [index,day] of [1,2,3].entries())await consumer.accept(turn(`covered-${index}`,`actor-${index}`,"查询用户信息后查询订单",[call(1,"user","lookup","query"),call(2,"order","query","query")],at(day),{attemptedSkillId:"user-order-skill"}));
    const result=await new AnalysisBatchService(repository,permissive,resolver).runBatch();
    expect(result.candidates).toBe(0); expect(await repository.listOutbox()).toEqual([]);
  });

  it("is idempotent and excludes untrusted input from clustering", async () => {
    const repository=new MemoryAnalysisRepository(); const consumer=new AnalysisInputConsumer(repository);
    const input=turn("same","a1","查询订单",[call(1,"order","query","query")],at(1));
    expect(await consumer.accept(input)).toBe(true); expect(await consumer.accept(input)).toBe(false);
    await consumer.accept(turn("suspect","a2","查询订单",[call(1,"order","query","query")],at(1),{collectionTrust:"suspect"}));
    const first=await new AnalysisBatchService(repository,{minimumSamples:99}).runBatch(); const second=await new AnalysisBatchService(repository,{minimumSamples:99}).runBatch();
    expect(first).toMatchObject({read:2,analyzed:2,skipped:1}); expect(second.read).toBe(0);
    expect((await repository.listClusters())[0]?.sampleCount).toBe(1);
  });

  it("uses the latest settlement version before a batch and refuses silent revision after analysis", async () => {
    const repository=new MemoryAnalysisRepository(); const consumer=new AnalysisInputConsumer(repository);
    const first=turn("version-1","a1","查询订单",[call(1,"order","query","query")],at(1),{turnId:"versioned-turn",settlementVersion:1});
    const second=turn("version-2","a1","查询用户信息后查询订单",[call(1,"user","lookup","query"),call(2,"order","query","query")],at(1),{turnId:"versioned-turn",settlementVersion:2});
    await consumer.accept(first); await consumer.accept(second);
    expect((await new AnalysisBatchService(repository,{minimumSamples:99}).runBatch()).read).toBe(1);
    expect((await repository.listClusters())[0]?.modulePath).toEqual(["user","order"]);
    await expect(consumer.accept({...second,eventId:"version-3",settlementVersion:3})).rejects.toThrow(/compensating rebuild/);
  });

  it("allows only one concurrent batch to hold the analysis lock", async () => {
    const repository=new MemoryAnalysisRepository(); const service=new AnalysisBatchService(repository);
    const results=await Promise.all([service.runBatch(),service.runBatch()]);
    expect(results.map((result)=>result.locked).sort()).toEqual([false,true]);
  });

  it("does not treat a successful response with retry behavior as quality success", async () => {
    const repository=new MemoryAnalysisRepository(); const consumer=new AnalysisInputConsumer(repository);
    for(const [index,day] of [1,2,3].entries())await consumer.accept(turn(`retry-${index}`,`retry-actor-${index}`,"查询用户信息后查询订单",[call(1,"user","lookup","query"),call(2,"order","query","query")],at(day),index===0?{behaviorSignals:{retried:true}}:{}));
    const result=await new AnalysisBatchService(repository,permissive).runBatch();
    expect(result.candidates).toBe(0); expect((await repository.listClusters())[0]).toMatchObject({sampleCount:3,successCount:2});
  });
});
