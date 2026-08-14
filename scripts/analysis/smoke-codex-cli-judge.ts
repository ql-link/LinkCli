import { CodexCliClusterJudge } from "../../src/analysis/cluster-judge.js";

const judge=new CodexCliClusterJudge({
  command:process.env.L3_CODEX_CLI_COMMAND??"codex",
  model:process.env.L3_CODEX_CLI_MODEL??"gpt-5.3-codex-spark",
  reasoningEffort:(process.env.L3_CODEX_CLI_REASONING_EFFORT??"medium") as "low"|"medium"|"high"|"xhigh",
  timeoutMs:Number(process.env.L3_CODEX_CLI_TIMEOUT_MS??"60000"),
});

const cases=[
  {name:"assignment-order-management",expected:{clusterId:2},run:()=>judge.assign({query:"取消客户还没发货的订单",candidates:[{clusterId:1,representativeQueries:["核实用户拥有哪些订单权限","为什么客户不能审批订单"]},{clusterId:2,representativeQueries:["修改客户订单的收货地址","撤销刚提交的订单"]}]})},
  {name:"assignment-delivery-tracking",expected:{clusterId:12},run:()=>judge.assign({query:"查客户订单现在由哪个网点配送",candidates:[{clusterId:11,representativeQueries:["查询订单审批权限"]},{clusterId:12,representativeQueries:["订单物流到哪里了","跟踪订单配送进度"]},{clusterId:13,representativeQueries:["取消未发货订单"]}]})},
  {name:"merge-same-demand",expected:{sameDemand:true},run:()=>judge.shouldMerge({left:{clusterId:21,representativeQueries:["修改客户订单地址","取消未发货订单"]},right:{clusterId:22,representativeQueries:["变更订单收货信息","撤销刚创建的订单"]}})},
  {name:"merge-different-demand",expected:{sameDemand:false},run:()=>judge.shouldMerge({left:{clusterId:31,representativeQueries:["核实订单审批权限","查询用户订单授权"]},right:{clusterId:32,representativeQueries:["跟踪订单物流","查询订单配送网点"]}})},
] as const;

const results=[];
for(const item of cases){
  const startedAt=Date.now();
  try{
    const actual=await item.run();const passed=Object.entries(item.expected).every(([key,value])=>(actual as Record<string,unknown>)[key]===value);
    results.push({name:item.name,passed,durationMs:Date.now()-startedAt,expected:item.expected,actual});
  }catch(error){results.push({name:item.name,passed:false,durationMs:Date.now()-startedAt,expected:item.expected,error:error instanceof Error?error.message:"Unknown error"});}
}
const report={modelVersion:judge.modelVersion,total:results.length,passed:results.filter((item)=>item.passed).length,results};
process.stdout.write(`${JSON.stringify(report,null,2)}\n`);
if(report.passed!==report.total)process.exitCode=1;
