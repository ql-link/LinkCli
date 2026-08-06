import { useQuery } from "@tanstack/react-query";
import { ArrowUpRight, Checks } from "@phosphor-icons/react";
import { Link } from "react-router-dom";
import { api } from "../../api/client";
import type { Version } from "../../api/types";
import { Empty, PageHeader, Status } from "../../components/AppShell";

export function ReviewsPage() {
  const query = useQuery({ queryKey: ["reviews"], queryFn: () => api<Version[]>("/api/reviews") });
  return <>
    <PageHeader eyebrow="独立审核" title="审核队列" description="只展示待审核且不是由当前账号提交的候选版本，确保双人复核。" />
    {query.data?.length ? <div className="space-y-3">{query.data.map(version => <Link to={`/versions/${version.id}`} key={version.id} className="panel panel-interactive group grid gap-5 p-6 md:grid-cols-[auto_1fr_auto] md:items-center">
      <span className="grid h-12 w-12 place-items-center rounded-[14px] bg-[#eeeef0] text-[#1d1d1f]"><Checks size={23} weight="bold" /></span>
      <div><p className="text-lg font-semibold tracking-[-.025em]">{version.project?.displayName} <span className="text-[#8a8a8e]">· v{version.versionNo}</span></p><p className="mt-2 break-all text-sm text-[#6e6e73]">{version.endpoint}</p></div>
      <div className="flex items-center gap-3"><Status value={version.riskLevel} /><span className="grid h-10 w-10 place-items-center rounded-full border border-[#d2d2d7] text-[#1d1d1f] transition-transform duration-500 group-hover:rotate-45"><ArrowUpRight size={18} weight="bold" /></span></div>
    </Link>)}</div> : <Empty title="没有待审核版本" description="新的候选版本提交后会出现在这里。" />}
  </>;
}
