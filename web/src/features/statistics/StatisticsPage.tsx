import { useQuery } from "@tanstack/react-query";
import { ArrowUpRight, ChartLineUp, Clock, Pulse, Wrench } from "@phosphor-icons/react";
import { Link, useParams } from "react-router-dom";
import { api } from "../../api/client";
import type { StatisticsSummary, StatisticsTurn, ToolStatistic, TurnDetail } from "../../api/types";
import { Empty, LoadError, PageHeader, Status } from "../../components/AppShell";

const percent=(value:number)=>`${(value*100).toFixed(value?1:0)}%`;
const duration=(value:number|null)=>value===null?"—":`${value} ms`;
const time=(value:string)=>new Date(value).toLocaleString("zh-CN",{hour12:false});

export function StatisticsPage(){
  const summary=useQuery({queryKey:["statistics","summary"],queryFn:()=>api<StatisticsSummary>("/api/statistics/summary")});
  const tools=useQuery({queryKey:["statistics","tools"],queryFn:()=>api<ToolStatistic[]>("/api/statistics/tools")});
  const turns=useQuery({queryKey:["statistics","turns"],queryFn:()=>api<StatisticsTurn[]>("/api/statistics/turns?limit=50")});
  const data=summary.data;
  return <>
    <PageHeader eyebrow="L2 · 调用数据采集" title="调用与轮次" description="基于已结算轮次查看调用成功率、归因质量和真实工具链；原始问题与调用明细按保留策略展示。"/>
    {summary.isError?<LoadError error={summary.error} onRetry={()=>summary.refetch()}/>:data?<section className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
      <Metric icon={Pulse} label="工具调用" value={data.calls.total} note={`${data.calls.success} 成功 · ${data.calls.error} 失败`}/>
      <Metric icon={ChartLineUp} label="错误率" value={percent(data.calls.errorRate)} note={`${data.calls.partial} 条部分记录`}/>
      <Metric icon={Clock} label="P95 耗时" value={duration(data.calls.durationMs.p95)} note={`P50 ${duration(data.calls.durationMs.p50)}`}/>
      <Metric icon={Wrench} label="已结算轮次" value={data.turns.settled} note={`共 ${data.turns.total} 轮`}/>
    </section>:<p className="text-sm text-[#6e6e73]">正在加载调用统计…</p>}
    <section className="mt-7 panel overflow-x-auto"><header className="border-b border-[#e3e3e6] p-5"><h2 className="font-semibold">工具表现</h2><p className="mt-1 text-xs text-[#6e6e73]">按项目和工具聚合</p></header>{tools.isError?<LoadError error={tools.error} onRetry={()=>tools.refetch()}/>:tools.isPending?<p className="p-5 text-sm text-[#6e6e73]">正在加载工具统计…</p>:tools.data.length?<table className="data-table"><thead><tr><th>项目 / 工具</th><th>调用</th><th>成功率</th><th>平均耗时</th><th>异常</th></tr></thead><tbody>{tools.data.map(row=><tr key={`${row.projectId}-${row.toolName}`}><td><p className="text-sm font-medium">{row.projectKey}</p><p className="mt-1 font-mono text-xs text-[#6e6e73]">{row.toolName}</p></td><td>{row.calls}</td><td>{percent(row.calls?row.success/row.calls:0)}</td><td>{duration(row.averageDurationMs)}</td><td>{row.error} 失败 · {row.partial} 部分</td></tr>)}</tbody></table>:<Empty title="暂无工具调用" description="统一网关产生调用记录后，这里会显示真实统计。"/>}</section>
    <section className="mt-7 panel overflow-hidden"><header className="border-b border-[#e3e3e6] p-5"><h2 className="font-semibold">最近轮次</h2><p className="mt-1 text-xs text-[#6e6e73]">一轮用户输入及其完整调用链</p></header>{turns.isError?<LoadError error={turns.error} onRetry={()=>turns.refetch()}/>:turns.isPending?<p className="p-5 text-sm text-[#6e6e73]">正在加载轮次…</p>:turns.data.length?<div className="divide-y divide-[#e3e3e6]">{turns.data.map(turn=><Link key={turn.id} to={`/statistics/turns/${turn.id}`} className="group flex items-center justify-between gap-5 p-5 hover:bg-[#fbfbfc]"><div className="min-w-0"><p className="truncate text-sm font-medium">{turn.userQuestion??"未采集用户问题"}</p><div className="mt-2 flex flex-wrap items-center gap-2"><Status value={turn.attributionQuality}/><span className="text-xs text-[#6e6e73]">{turn.callCount} 次调用 · {time(turn.lastEventAt)}</span></div></div><ArrowUpRight className="shrink-0"/></Link>)}</div>:<Empty title="暂无已结算轮次" description="L2 完成结算后，轮次会出现在这里。"/>}</section>
  </>;
}

export function TurnDetailPage(){const{id}=useParams();const query=useQuery({queryKey:["statistics","turn",id],queryFn:()=>api<TurnDetail>(`/api/statistics/turns/${id}`)});const data=query.data;if(query.isError)return <LoadError error={query.error} onRetry={()=>query.refetch()}/>;if(!data)return <p className="text-sm text-[#6e6e73]">正在加载轮次…</p>;return <><PageHeader eyebrow="L2 · 轮次明细" title={data.turn.userQuestion??"未采集用户问题"} description={`轮次 ${data.turn.id}`}/><section className="grid gap-4 md:grid-cols-4"><Small label="归因质量"><Status value={data.turn.attributionQuality}/></Small><Small label="结算状态"><Status value={data.turn.settlementStatus}/></Small><Small label="调用数"><b className="text-2xl">{data.turn.callCount}</b></Small><Small label="发生时间"><span className="text-sm">{time(data.turn.firstEventAt)}</span></Small></section>{data.detailsPurged&&<p className="mt-5 rounded-xl bg-amber-50 p-4 text-sm text-amber-800">调用明细已按保留策略清理，聚合后的规范调用链仍可用于统计。</p>}<section className="mt-6 space-y-3">{data.calls.map((call,index)=><article key={call.id} className="panel p-5"><div className="flex flex-wrap items-center justify-between gap-3"><div><p className="text-xs text-[#6e6e73]">步骤 {index+1}{call.parallelGroup!==null?` · 并行组 ${call.parallelGroup}`:""}</p><h2 className="mt-1 font-mono font-semibold">{call.projectKey} / {call.toolName}</h2></div><div className="flex gap-2"><Status value={call.outcome}/><span className="text-sm text-[#6e6e73]">{duration(call.durationMs)}</span></div></div>{call.errorCode&&<p className="mt-4 text-sm text-red-600">{call.errorCode}</p>}</article>)}</section></>}
function Metric({icon:Icon,label,value,note}:{icon:typeof Pulse;label:string;value:string|number;note:string}){return <article className="panel p-5"><Icon size={19}/><p className="mt-7 text-3xl font-semibold tracking-[-.04em]">{value}</p><p className="mt-3 text-sm font-medium">{label}</p><p className="mt-1 text-xs text-[#6e6e73]">{note}</p></article>}
function Small({label,children}:{label:string;children:React.ReactNode}){return <article className="panel p-5"><p className="eyebrow mb-4">{label}</p>{children}</article>}
