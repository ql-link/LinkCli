import { useRef } from "react";
import { useQuery } from "@tanstack/react-query";
import { ArrowRight, ArrowUpRight, Key, Pulse, Stack } from "@phosphor-icons/react";
import { Link } from "react-router-dom";
import { useGSAP } from "@gsap/react";
import gsap from "gsap";
import { api } from "../../api/client";
import type { Dashboard } from "../../api/types";
import { Empty, PageHeader, Status } from "../../components/AppShell";

export function DashboardPage() {
  const root = useRef<HTMLDivElement>(null);
  const query = useQuery({ queryKey: ["dashboard"], queryFn: () => api<Dashboard>("/api/dashboard") });
  const data = query.data;
  useGSAP(() => { if (data) gsap.from(".dashboard-enter", { y: 14, opacity: 0, duration: .45, stagger: .06, ease: "power3.out" }); }, { scope: root, dependencies: [data] });
  if (!data) return <div className="text-sm text-[#6e6e73]">正在加载工作台…</div>;

  const metrics = [
    { label: "接入项目", value: data.projects.total, detail: `${data.projects.active} 个正在服务`, icon: Stack },
    { label: "健康异常", value: data.projects.unhealthy, detail: "需要检查连接", icon: Pulse },
    { label: "有效凭据", value: data.credentials.active, detail: `${data.credentials.expiringWithinSevenDays} 个即将到期`, icon: Key },
  ];

  return <div ref={root}>
    <PageHeader eyebrow="工作台" title="运行概览" description="查看当前账号可见的项目、健康状态与待处理事项。" action={<Link className="btn-primary" to="/projects/new">登记 MCP 项目<ArrowRight size={15} /></Link>} />
    <section className="grid grid-flow-dense gap-5 sm:grid-cols-2 xl:grid-cols-3">
      {metrics.map(metric => <article key={metric.label} className="dashboard-enter panel panel-interactive min-h-[190px] p-6"><span className="grid h-11 w-11 place-items-center rounded-[10px] bg-[#eeeef0]"><metric.icon size={20} /></span><p className="mt-8 text-4xl font-semibold tracking-[-.05em]">{metric.value}</p><div className="mt-4 flex items-end justify-between gap-3"><p className="text-sm font-medium">{metric.label}</p><p className="text-xs text-[#6e6e73]">{metric.detail}</p></div></article>)}
    </section>
    <section className="dashboard-enter mt-8 panel overflow-hidden">
      <header className="flex items-center justify-between border-b border-[#e3e3e6] px-5 py-4"><div><h2 className="font-semibold">待处理事项</h2><p className="mt-1 text-xs text-[#6e6e73]">异常、审核和即将到期的凭据</p></div>{data.reviews && <div className="flex items-center gap-2"><Status value="pending_review" /><span className="text-xs text-[#6e6e73]">{data.reviews.pending} 条</span></div>}</header>
      {data.attention.length ? <div className="divide-y divide-[#e3e3e6]">{data.attention.map(item => <Link key={`${item.type}-${item.id}`} to={item.href} className="group flex items-center justify-between gap-5 px-5 py-4 hover:bg-[#fbfbfc]"><div><p className="text-sm font-medium">{item.title}</p><p className="mt-1 text-xs text-[#6e6e73]">{item.description}</p></div><ArrowUpRight size={17} className="text-[#6e6e73] transition-transform group-hover:translate-x-0.5 group-hover:-translate-y-0.5" /></Link>)}</div> : <Empty title="当前没有待处理事项" description="项目、审核或凭据需要关注时会出现在这里。" />}
    </section>
  </div>;
}
