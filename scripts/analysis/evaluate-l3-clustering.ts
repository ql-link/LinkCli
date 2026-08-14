import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { AnalysisBatchService } from "../../src/analysis/batch-service.js";
import { DeterministicFallbackEmbeddingProvider, LocalEmbeddingProvider, RemoteEmbeddingProvider, type EmbeddingProvider } from "../../src/analysis/embedding-provider.js";
import type { ClusterJudge } from "../../src/analysis/cluster-judge.js";
import { AnalysisInputConsumer } from "../../src/analysis/input-consumer.js";
import { ClusterRebuildJob } from "../../src/analysis/rebuild.js";
import { MemoryAnalysisRepository } from "../../src/analysis/repository.js";
import { averageVector, cosineSimilarity, modulePathOf } from "../../src/analysis/similarity.js";
import { defaultClusterThresholds, type ClusterMember } from "../../src/analysis/types.js";
import { labeledQueries, labeledQueryDatasetVersion, type LabeledQueryFixture } from "../../tests/fixtures/l3-operational-data.js";

interface Pair { left:LabeledQueryFixture; right:LabeledQueryFixture; similarity:number; sameLabel:boolean }
interface Metrics { precision:number; recall:number; f1:number; truePositive:number; falsePositive:number; falseNegative:number }

class EvaluationRepository extends MemoryAnalysisRepository {
  readonly assignments = new Map<number,number>();
  override async addMember(member:ClusterMember):Promise<boolean>{
    const inserted=await super.addMember(member); if(inserted)this.assignments.set(member.analysisInputId,member.clusterId); return inserted;
  }
  override async mergeClusters(targetClusterId:number,sourceClusterId:number):Promise<void>{
    await super.mergeClusters(targetClusterId,sourceClusterId);
    for(const [inputId,clusterId] of this.assignments)if(clusterId===sourceClusterId)this.assignments.set(inputId,targetClusterId);
  }
}

class CachedEmbeddingProvider implements EmbeddingProvider {
  readonly candidateHandoffEnabled = false;
  readonly modelVersion: string;
  private readonly vectors = new Map<string,number[]>();
  constructor(private readonly delegate:EmbeddingProvider){this.modelVersion=`evaluation-cache:${delegate.modelVersion}`;}
  async prepare(texts:string[],batchSize=16):Promise<void>{
    for(let start=0;start<texts.length;start+=batchSize){
      const batch=texts.slice(start,start+batchSize); const vectors=await this.delegate.embed(batch);
      batch.forEach((text,index)=>this.vectors.set(text,vectors[index]!));
    }
  }
  async embed(texts:string[]):Promise<number[][]>{
    return texts.map((text)=>{const vector=this.vectors.get(text);if(!vector)throw new Error(`Embedding cache miss for Query: ${text}`);return vector;});
  }
}

class OracleEmbeddingProvider implements EmbeddingProvider {
  readonly modelVersion = "evaluation:label-oracle";
  readonly candidateHandoffEnabled = false;
  private readonly labels=[...new Set(labeledQueries.map((item)=>item.label))].sort();
  private readonly queryLabels=new Map(labeledQueries.map((item)=>[item.query,item.label]));
  async embed(texts:string[]):Promise<number[][]>{return texts.map((text)=>{
    const label=this.queryLabels.get(text);if(!label)throw new Error(`Oracle has no label for Query: ${text}`);
    return this.labels.map((item)=>item===label?1:0);
  });}
}

/** 只验证 Top-K 召回与聚类管线的标签 Oracle；不能作为真实 LLM 质量证据。 */
class FixtureOracleClusterJudge implements ClusterJudge {
  readonly modelVersion="evaluation:label-oracle-judge";
  readonly candidateHandoffEnabled=false;
  private readonly queryLabels=new Map(labeledQueries.map((item)=>[item.query,item.label]));
  async assign({query,candidates}:Parameters<ClusterJudge["assign"]>[0]){
    const label=this.queryLabels.get(query);if(!label)throw new Error(`Oracle has no label for Query: ${query}`);
    const target=candidates.find((candidate)=>candidate.representativeQueries.some((sample)=>this.queryLabels.get(sample)===label));
    return{clusterId:target?.clusterId??null,confidence:1,reason:target?"gold label matched in Top-K":"gold label absent from Top-K"};
  }
  async shouldMerge({left,right}:Parameters<ClusterJudge["shouldMerge"]>[0]){
    const leftLabels=new Set(left.representativeQueries.map((query)=>this.queryLabels.get(query)));const rightLabels=new Set(right.representativeQueries.map((query)=>this.queryLabels.get(query)));
    const same=[...leftLabels].some((label)=>label!==undefined&&rightLabels.has(label));
    return{sameDemand:same,confidence:1,reason:same?"gold labels match":"gold labels differ"};
  }
}

function argument(name:string):string|undefined{
  const prefix=`--${name}=`; return process.argv.slice(2).find((item)=>item.startsWith(prefix))?.slice(prefix.length);
}

function bucketOf(item:LabeledQueryFixture):string{
  const path=modulePathOf(item.calls); return `${path.projectScope??""}:${path.modulePathHash??""}`;
}

function pairsFor(items:LabeledQueryFixture[],vectors:Map<string,number[]>):Pair[]{
  const pairs:Pair[]=[];
  for(let left=0;left<items.length;left+=1)for(let right=left+1;right<items.length;right+=1){
    const a=items[left]!;const b=items[right]!;if(bucketOf(a)!==bucketOf(b))continue;
    pairs.push({left:a,right:b,similarity:cosineSimilarity(vectors.get(a.id)!,vectors.get(b.id)!),sameLabel:a.label===b.label});
  }
  return pairs;
}

function metrics(pairs:Pair[],threshold:number):Metrics{
  let truePositive=0;let falsePositive=0;let falseNegative=0;
  for(const pair of pairs){const predicted=pair.similarity>=threshold;if(predicted&&pair.sameLabel)truePositive+=1;else if(predicted)falsePositive+=1;else if(pair.sameLabel)falseNegative+=1;}
  const precision=truePositive+falsePositive===0?0:truePositive/(truePositive+falsePositive);
  const recall=truePositive+falseNegative===0?0:truePositive/(truePositive+falseNegative);
  return{precision,recall,f1:precision+recall===0?0:2*precision*recall/(precision+recall),truePositive,falsePositive,falseNegative};
}

function calibrate(pairs:Pair[]):{threshold:number;metrics:Metrics}{
  const thresholds=[...new Set(pairs.map((pair)=>pair.similarity))].sort((a,b)=>b-a);
  let best={threshold:1.000001,metrics:metrics(pairs,1.000001)};
  for(const threshold of thresholds){const current=metrics(pairs,threshold);if(current.f1>best.metrics.f1||(current.f1===best.metrics.f1&&current.precision>best.metrics.precision)||(current.f1===best.metrics.f1&&current.precision===best.metrics.precision&&threshold>best.threshold))best={threshold,metrics:current};}
  return best;
}

function distribution(pairs:Pair[],sameLabel:boolean):Record<string,number|null>{
  const values=pairs.filter((pair)=>pair.sameLabel===sameLabel).map((pair)=>pair.similarity).sort((a,b)=>a-b);
  const quantile=(ratio:number):number|null=>values.length?values[Math.min(values.length-1,Math.floor((values.length-1)*ratio))]!:null;
  return{count:values.length,min:values[0]??null,p10:quantile(0.1),median:quantile(0.5),p90:quantile(0.9),max:values.at(-1)??null};
}

function roundRobin(items:LabeledQueryFixture[]):LabeledQueryFixture[]{
  const groups=new Map<string,LabeledQueryFixture[]>();for(const item of items){const group=groups.get(item.label)??[];group.push(item);groups.set(item.label,group);}
  const labels=[...groups.keys()].sort();const ordered:LabeledQueryFixture[]=[];
  for(let index=0;;index+=1){let added=false;for(const label of labels){const item=groups.get(label)?.[index];if(item){ordered.push(item);added=true;}}if(!added)return ordered;}
}

function categoryRecallMetrics(items:LabeledQueryFixture[],vectors:Map<string,number[]>):Record<string,unknown>{
  const buckets=new Map<string,Map<string,number[][]>>();const ranks:number[]=[];
  for(const item of roundRobin(items)){
    const bucket=buckets.get(bucketOf(item))??new Map<string,number[][]>();const ownVectors=bucket.get(item.label);
    if(ownVectors){
      const ranked=[...bucket.entries()].map(([label,categoryVectors])=>({label,similarity:cosineSimilarity(vectors.get(item.id)!,averageVector(categoryVectors))})).sort((left,right)=>right.similarity-left.similarity);
      ranks.push(ranked.findIndex((candidate)=>candidate.label===item.label)+1);
    }
    bucket.set(item.label,[...(ownVectors??[]),vectors.get(item.id)!]);buckets.set(bucketOf(item),bucket);
  }
  const recallAt=(k:number):number=>ranks.length===0?0:ranks.filter((rank)=>rank>0&&rank<=k).length/ranks.length;
  return{evaluatedQueries:ranks.length,recallAt1:recallAt(1),recallAt3:recallAt(3),recallAt5:recallAt(5),missedAt5:ranks.filter((rank)=>rank===0||rank>5).length,maxRank:Math.max(0,...ranks)};
}

function assignmentMetrics(items:LabeledQueryFixture[],assignments:Map<string,number>):Record<string,unknown>{
  let truePositive=0;let falsePositive=0;let falseNegative=0;
  for(let left=0;left<items.length;left+=1)for(let right=left+1;right<items.length;right+=1){
    const a=items[left]!;const b=items[right]!;if(bucketOf(a)!==bucketOf(b))continue;
    const predicted=assignments.get(a.id)===assignments.get(b.id);const expected=a.label===b.label;
    if(predicted&&expected)truePositive+=1;else if(predicted)falsePositive+=1;else if(expected)falseNegative+=1;
  }
  const pairMetrics=metricsFromCounts(truePositive,falsePositive,falseNegative);
  const clusters=new Map<number,LabeledQueryFixture[]>();for(const item of items){const clusterId=assignments.get(item.id)!;const cluster=clusters.get(clusterId)??[];cluster.push(item);clusters.set(clusterId,cluster);}
  const fragmentation=[...new Set(items.map((item)=>item.label))].map((label)=>new Set(items.filter((item)=>item.label===label).map((item)=>assignments.get(item.id))).size);
  return{...pairMetrics,clusterCount:clusters.size,goldClusterCount:new Set(items.map((item)=>item.label)).size,singletonRatio:[...clusters.values()].filter((cluster)=>cluster.length===1).length/clusters.size,
    overmergedClusters:[...clusters.values()].filter((cluster)=>new Set(cluster.map((item)=>item.label)).size>1).length,averageFragmentsPerGold:fragmentation.reduce((sum,value)=>sum+value,0)/fragmentation.length,maxFragmentsPerGold:Math.max(...fragmentation)};
}

function metricsFromCounts(truePositive:number,falsePositive:number,falseNegative:number):Metrics{
  const precision=truePositive+falsePositive===0?0:truePositive/(truePositive+falsePositive);const recall=truePositive+falseNegative===0?0:truePositive/(truePositive+falseNegative);
  return{precision,recall,f1:precision+recall===0?0:2*precision*recall/(precision+recall),truePositive,falsePositive,falseNegative};
}

function pairErrors(pairs:Pair[],threshold:number,kind:"false_positive"|"false_negative"):Array<Record<string,unknown>>{
  return pairs.filter((pair)=>kind==="false_positive"?!pair.sameLabel&&pair.similarity>=threshold:pair.sameLabel&&pair.similarity<threshold)
    .sort((a,b)=>kind==="false_positive"?b.similarity-a.similarity:a.similarity-b.similarity).slice(0,10)
    .map((pair)=>({leftId:pair.left.id,leftQuery:pair.left.query,rightId:pair.right.id,rightQuery:pair.right.query,similarity:pair.similarity}));
}

async function providerOf():Promise<{name:string;provider:EmbeddingProvider;qualityEvidence:boolean}>{
  const name=argument("provider")??"fallback";
  if(name==="fallback")return{name,provider:new DeterministicFallbackEmbeddingProvider(),qualityEvidence:false};
  if(name==="oracle")return{name,provider:new OracleEmbeddingProvider(),qualityEvidence:false};
  if(name==="local"){
    const model=argument("model")??"Xenova/paraphrase-multilingual-MiniLM-L12-v2";const dimensions=Number(argument("dimensions")??"384");
    return{name,provider:new LocalEmbeddingProvider(model,dimensions,{dtype:(argument("dtype")??"q8") as "q8",cacheDir:argument("cache-dir"),localFilesOnly:(argument("local-files-only")??"true")!=="false"}),qualityEvidence:true};
  }
  if(name==="remote"){
    const endpoint=process.env.L3_EMBEDDING_ENDPOINT;const apiKey=process.env.L3_EMBEDDING_API_KEY;const model=process.env.L3_EMBEDDING_MODEL;const dimensions=Number(process.env.L3_EMBEDDING_DIMENSIONS);
    if(!endpoint||!apiKey||!model||!Number.isInteger(dimensions))throw new Error("Remote evaluation requires all L3_EMBEDDING_* settings");
    return{name,provider:new RemoteEmbeddingProvider({endpoint,apiKey,model,dimensions}),qualityEvidence:true};
  }
  throw new Error(`Unsupported provider: ${name}`);
}

async function main():Promise<void>{
  const startedAt=new Date();const selected=await providerOf();const cached=new CachedEmbeddingProvider(selected.provider);
  const embeddingBatchSize=Number(argument("batch-size")??"10");
  if(!Number.isInteger(embeddingBatchSize)||embeddingBatchSize<1)throw new Error("batch-size must be a positive integer");
  await cached.prepare(labeledQueries.map((item)=>item.query),embeddingBatchSize);
  const vectorRows=await cached.embed(labeledQueries.map((item)=>item.query));const vectors=new Map(labeledQueries.map((item,index)=>[item.id,vectorRows[index]!]));
  const tunePairs=pairsFor(labeledQueries.filter((item)=>item.split==="tune"),vectors);const blindPairs=pairsFor(labeledQueries.filter((item)=>item.split==="blind"),vectors);
  const calibrated=calibrate(tunePairs);const blindMetrics=metrics(blindPairs,calibrated.threshold);

  const repository=new EvaluationRepository();const consumer=new AnalysisInputConsumer(repository);const ordered=roundRobin(labeledQueries);const oracleJudge=new FixtureOracleClusterJudge();
  for(const [index,item] of ordered.entries())await consumer.accept({eventId:`eval-${item.id}`,turnId:`eval-turn-${item.id}`,settlementVersion:1,actorHash:createHash("sha256").update(`actor-${index}`).digest("hex"),queryText:item.query,calls:item.calls,settlementStatus:"success",collectionTrust:"trusted",occurredAt:new Date(Date.UTC(2026,0,1+index))});
  const decisionSettings={recallTopK:Number(argument("top-k")??"5"),representativeQueryLimit:Number(argument("representatives")??"3"),minimumRecallSimilarity:Number(argument("minimum-recall-similarity")??"0")};
  const service=new AnalysisBatchService(repository,cached,oracleJudge,{minimumSamples:999},undefined,false,decisionSettings);const batch=await service.runBatch(1_000,new Date(Date.UTC(2026,6,1)));
  const rebuild=await new ClusterRebuildJob(repository,oracleJudge,{...defaultClusterThresholds,minimumSamples:999},decisionSettings).runOnce();
  const assignments=new Map<string,number>();for(const [index,item] of ordered.entries())assignments.set(item.id,repository.assignments.get(index+1)!);
  const overallClustering=assignmentMetrics(labeledQueries,assignments);const blindClustering=assignmentMetrics(labeledQueries.filter((item)=>item.split==="blind"),assignments);const categoryRecall=categoryRecallMetrics(labeledQueries,vectors);
  const experimentalGate={pairwiseBlindPrecisionAtLeast:0.9,pairwiseBlindRecallAtLeast:0.8,clusteringF1AtLeast:0.8,overmergedClustersAtMost:0};
  const experimentalPass=blindMetrics.precision>=0.9&&blindMetrics.recall>=0.8&&Number(overallClustering.f1)>=0.8&&Number(overallClustering.overmergedClusters)<=0;
  const report={datasetVersion:labeledQueryDatasetVersion,queryCount:labeledQueries.length,labelCount:new Set(labeledQueries.map((item)=>item.label)).size,projectCount:new Set(labeledQueries.flatMap((item)=>item.calls.map((call)=>call.projectId))).size,
    provider:selected.name,modelVersion:selected.provider.modelVersion,qualityEvidence:selected.qualityEvidence,startedAt:startedAt.toISOString(),finishedAt:new Date().toISOString(),durationMs:Date.now()-startedAt.getTime(),
    calibration:{method:"tune pairwise F1 optimum within identical Project + ordered Module path",threshold:calibrated.threshold,tune:calibrated.metrics,blind:blindMetrics,sameLabelDistribution:distribution(tunePairs,true),differentLabelDistribution:distribution(tunePairs,false)},
    pipeline:{judge:"label-oracle-upper-bound",decisionSettings,categoryRecall,batch,rebuild,overall:overallClustering,blind:blindClustering},experimentalGate,experimentalPass:null,
    errors:{blindFalsePositives:pairErrors(blindPairs,calibrated.threshold,"false_positive"),blindFalseNegatives:pairErrors(blindPairs,calibrated.threshold,"false_negative")},
    limitations:["Pairwise threshold metrics are embedding diagnostics only; thresholds no longer make final category decisions.","The pipeline uses a gold-label Oracle judge to measure the Top-K recall upper bound, not real LLM quality.","The dataset is curated operational data, not production traffic.",...(selected.qualityEvidence?[]:["This embedding provider is not valid evidence of semantic recall quality."])]};
  const output=argument("output");if(output){await mkdir(dirname(output),{recursive:true});await writeFile(output,`${JSON.stringify(report,null,2)}\n`,"utf8");}
  process.stdout.write(`${JSON.stringify(report,null,2)}\n`);
}

await main();
