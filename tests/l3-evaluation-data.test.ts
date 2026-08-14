import { describe, expect, it } from "vitest";
import { labeledQueries, operationalProjects } from "./fixtures/l3-operational-data.js";
import { modulePathOf } from "../src/analysis/similarity.js";

describe("L3 labeled operational evaluation data",()=>{
  it("contains balanced, unique, multi-project labels with blind examples",()=>{
    expect(labeledQueries).toHaveLength(78);
    expect(new Set(labeledQueries.map((item)=>item.id)).size).toBe(labeledQueries.length);
    expect(operationalProjects).toHaveLength(6);
    const counts=new Map<string,{tune:number;blind:number}>();
    for(const item of labeledQueries){
      const count=counts.get(item.label)??{tune:0,blind:0};
      count[item.split]+=1; counts.set(item.label,count);
      expect(modulePathOf(item.calls).modulePath).not.toBeNull();
    }
    expect(counts.size).toBe(13);
    expect([...counts.values()]).toEqual(new Array(13).fill(null).map(()=>({tune:4,blind:2})));
  });

  it("contains hard negatives inside the same candidate bucket",()=>{
    const bucketLabels=new Map<string,Set<string>>();
    for(const item of labeledQueries){
      const path=modulePathOf(item.calls);
      const key=`${path.projectScope}:${path.modulePathHash}`;
      const labels=bucketLabels.get(key)??new Set<string>(); labels.add(item.label); bucketLabels.set(key,labels);
    }
    expect([...bucketLabels.values()].filter((labels)=>labels.size>1).length).toBeGreaterThanOrEqual(6);
  });
});
