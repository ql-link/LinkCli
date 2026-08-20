import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { MemoryAnalysisRepository } from "../src/analysis/repository.js";
import { MemoryIdentityRepository } from "../src/auth/repository.js";
import { IdentityService } from "../src/auth/service.js";
import { createApp } from "../src/app.js";
import { MemorySkillRepository } from "../src/skill/repository.js";
import { SkillService } from "../src/skill/service.js";
import { createHarness, registerSubmitted } from "./fixtures/harness.js";

describe("L3/L4 console API",()=>{
  const cleanup:Array<()=>Promise<void>>=[];
  afterEach(async()=>{for(const close of cleanup.splice(0).reverse())await close();});
  const post=(body:unknown)=>({method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(body)});

  it("shows only the member's clusters and linked Skills through the browser session",async()=>{
    const h=createHarness();const identity=new IdentityService(new MemoryIdentityRepository());
    const owner=await identity.register("layers.owner","分层负责人","strong-password-123");
    await identity.register("layers.other","其他成员","strong-password-123");
    const registered=await registerSubmitted(h);registered.project.ownerId=owner.id;await h.repository.updateProject(registered.project);
    const analysis=new MemoryAnalysisRepository();
    const cluster=await analysis.createCluster({clusterKey:"cluster-1",clusterType:"normal",projectScope:registered.project.id,modulePathHash:"path-1",modulePath:["knowledge"],representativeEventId:"event-1",representativeQuery:"检索企业知识",status:"handed_off",mergedIntoClusterId:null,sampleCount:20,distinctActorCount:5,successCount:19,coverageGapCount:0,attemptedSkillCount:0,semanticCohesion:.92,inputCompleteness:1,centroidVector:[1,0],embeddingModelVersion:"test:model:2",firstSeenAt:new Date("2026-08-01T00:00:00Z"),lastSeenAt:new Date("2026-08-05T00:00:00Z"),version:2});
    const skills=new SkillService(new MemorySkillRepository());
    const skill=await skills.receiveCandidate({eventId:"candidate-1",clusterId:cluster.id,clusterVersion:cluster.version,candidateType:"new_skill",payload:{representativeQuery:cluster.representativeQuery,toolPath:[{projectId:registered.project.id,serviceVersionId:registered.version.id,toolVersionId:registered.tools[0]!.id,toolName:registered.tools[0]!.originalName}]}});
    const validationJob=await skills.enqueueValidation(skill.id,"manual");
    const app=createApp({projects:h.projects,reviews:h.reviews,health:h.health,credentials:h.credentials,catalog:h.catalog,gateway:h.gateway},"admin-key-with-at-least-24-chars","127.0.0.1",undefined,{identity,repository:h.repository,projects:h.projects,reviews:h.reviews,health:h.health,credentials:h.credentials,analysis,skills});
    const server=app.listen(0,"127.0.0.1");await once(server,"listening");cleanup.push(()=>new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve())));const base=`http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const ownerLogin=await fetch(`${base}/api/auth/login`,post({username:"layers.owner",password:"strong-password-123"}));const ownerCookie=ownerLogin.headers.get("set-cookie")!;
    expect((await (await fetch(`${base}/api/analysis/clusters`,{headers:{cookie:ownerCookie}})).json()).data).toEqual([expect.objectContaining({id:cluster.id,representativeQuery:"检索企业知识"})]);
    expect((await (await fetch(`${base}/api/skills`,{headers:{cookie:ownerCookie}})).json()).data).toEqual([expect.objectContaining({id:skill.id})]);
    const detail=await (await fetch(`${base}/api/skills/${skill.id}`,{headers:{cookie:ownerCookie}})).json();expect(detail.data.version.definition.name).toBeTruthy();expect(detail.data.validationJobs).toEqual([expect.objectContaining({id:validationJob.id,status:"pending"})]);expect(detail.data.validationRuns).toEqual([]);
    const otherLogin=await fetch(`${base}/api/auth/login`,post({username:"layers.other",password:"strong-password-123"}));const otherCookie=otherLogin.headers.get("set-cookie")!;
    expect((await (await fetch(`${base}/api/analysis/clusters`,{headers:{cookie:otherCookie}})).json()).data).toEqual([]);
    expect((await (await fetch(`${base}/api/skills`,{headers:{cookie:otherCookie}})).json()).data).toEqual([]);
    expect((await fetch(`${base}/api/skills/${skill.id}`,{headers:{cookie:otherCookie}})).status).toBe(404);
  });
});
