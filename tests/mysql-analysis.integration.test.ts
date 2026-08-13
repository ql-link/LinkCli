import { createHash } from "node:crypto";
import mysql, { type Pool } from "mysql2/promise";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { AnalysisBatchService } from "../src/analysis/batch-service.js";
import { AnalysisInputConsumer } from "../src/analysis/input-consumer.js";
import { MySqlAnalysisRepository } from "../src/analysis/repository.js";
import type { AnalysisCall } from "../src/analysis/types.js";

const databaseUrl=process.env.LINKCLI_TEST_MYSQL_URL;
const realMySqlDescribe=databaseUrl?describe:describe.skip;
const actor=(value:string)=>createHash("sha256").update(value).digest("hex");
const call=(sequence:number,moduleId:string,toolName:string,operation:string):AnalysisCall=>({sequence,projectId:"commerce",moduleId,toolName,operation,parameterKeys:["id"],outcome:"success"});

async function reset(pool:Pool):Promise<void>{
  const connection=await pool.getConnection();
  try{
    const [[identity]]=await connection.query<mysql.RowDataPacket[]>("SELECT DATABASE() name"); const name=String(identity?.name??"");
    if(!/(?:_dev|_test)$/.test(name))throw new Error(`Refusing to reset non-test database: ${name}`);
    await connection.query("SET FOREIGN_KEY_CHECKS=0");
    try{for(const table of ["mcp_l4_validation_feedback","mcp_l4_candidate_outbox","mcp_cluster_score_history","mcp_skill_coverage_gap","mcp_query_cluster_scene","mcp_query_cluster_member","mcp_query_cluster","mcp_analysis_input"])await connection.query(`TRUNCATE TABLE \`${table}\``);}
    finally{await connection.query("SET FOREIGN_KEY_CHECKS=1");}
  }finally{connection.release();}
}

realMySqlDescribe("L3 real MySQL scheduled batch",()=>{
  let pool:Pool;
  beforeAll(()=>{pool=mysql.createPool({uri:databaseUrl!,connectionLimit:4,timezone:"Z",dateStrings:false});});
  beforeEach(()=>reset(pool),60_000);
  afterAll(async()=>{await reset(pool);await pool.end();});

  it("persists one broad cluster, three scenes and one idempotent L4 candidate",async()=>{
    const repository=new MySqlAnalysisRepository(pool,pool); const consumer=new AnalysisInputConsumer(repository);
    const inputs=[
      ["query","a1","查询用户信息后查询订单",call(2,"order","query","query")],
      ["update","a2","查询用户信息后修改订单",call(2,"order","update","update")],
      ["delete","a3","查询用户信息后删除订单",call(2,"order","delete","delete")],
    ] as const;
    for(const [eventId,actorId,queryText,second] of inputs)await consumer.accept({eventId,turnId:`turn-${eventId}`,settlementVersion:1,actorHash:actor(actorId),queryText,calls:[call(1,"user","lookup","query"),second],settlementStatus:"success",collectionTrust:"trusted",occurredAt:new Date(`2026-08-0${eventId==="query"?1:eventId==="update"?2:3}T00:00:00Z`)});
    const service=new AnalysisBatchService(repository,{minimumSamples:3,minimumActors:3,minimumSpanMs:2*24*60*60*1_000,minimumInputCompleteness:1,minimumCohesion:0.8,minimumSuccessRate:0.9,joinSimilarity:0.8});
    expect(await service.runBatch()).toMatchObject({locked:true,read:3,analyzed:3,candidates:1});
    const clusters=await repository.listClusters(); expect(clusters).toHaveLength(1); expect(clusters[0]).toMatchObject({modulePath:["user","order"],sampleCount:3,status:"handed_off"});
    expect(await repository.listScenes(clusters[0]!.id)).toHaveLength(3); expect(await repository.listOutbox()).toHaveLength(1);
    expect(await service.runBatch()).toMatchObject({read:0,candidates:0});
  },60_000);

  it("continues after a rolled-back input and keeps it pending for retry",async()=>{
    const repository=new MySqlAnalysisRepository(pool,pool); const consumer=new AnalysisInputConsumer(repository);
    await consumer.accept({eventId:"poison",turnId:"turn-poison",settlementVersion:1,actorHash:actor("poison"),queryText:"查询订单",calls:[call(1,"order","query","query")],settlementStatus:"success",collectionTrust:"trusted",attemptedSkillId:"order-skill",occurredAt:new Date("2026-08-01T00:00:00Z")});
    await consumer.accept({eventId:"healthy",turnId:"turn-healthy",settlementVersion:1,actorHash:actor("healthy"),queryText:"查询订单",calls:[call(1,"order","query","query")],settlementStatus:"success",collectionTrust:"trusted",occurredAt:new Date("2026-08-02T00:00:00Z")});
    const service=new AnalysisBatchService(repository,{minimumSamples:99},{async evaluate(){throw new Error("coverage metadata unavailable");}});
    expect(await service.runBatch()).toMatchObject({read:2,analyzed:1,failed:1});
    expect((await repository.listClusters())[0]).toMatchObject({sampleCount:1,representativeEventId:"healthy"});
    expect(await service.runBatch()).toMatchObject({read:1,analyzed:0,failed:1});
  },60_000);

  it("emits one expansion after an earlier new Skill candidate develops a coverage gap",async()=>{
    const repository=new MySqlAnalysisRepository(pool,pool); const consumer=new AnalysisInputConsumer(repository);
    const thresholds={minimumSamples:1,minimumActors:1,minimumSpanMs:0,minimumInputCompleteness:1,minimumCohesion:0,minimumSuccessRate:0,minimumCoverageGapCount:1,minimumCoverageGapRatio:1,joinSimilarity:0.8};
    const resolver={async evaluate(){return{covered:false as const,gapType:"partial_coverage" as const};}};
    await consumer.accept({eventId:"initial",turnId:"turn-initial",settlementVersion:1,actorHash:actor("initial"),queryText:"查询用户信息后查询订单",calls:[call(1,"user","lookup","query"),call(2,"order","query","query")],settlementStatus:"success",collectionTrust:"trusted",occurredAt:new Date("2026-08-01T00:00:00Z")});
    expect((await new AnalysisBatchService(repository,thresholds,resolver).runBatch()).candidates).toBe(1);
    await consumer.accept({eventId:"gap",turnId:"turn-gap",settlementVersion:1,actorHash:actor("gap"),queryText:"查询用户信息后删除订单",calls:[call(1,"user","lookup","query"),call(2,"order","delete","delete")],settlementStatus:"success",collectionTrust:"trusted",attemptedSkillId:"user-order-skill",occurredAt:new Date("2026-08-02T00:00:00Z")});
    expect((await new AnalysisBatchService(repository,thresholds,resolver).runBatch()).candidates).toBe(1);
    expect((await repository.listOutbox()).map((event)=>event.candidateType)).toEqual(["new_skill","expand_skill"]);
  },60_000);
});
