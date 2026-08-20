import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowUpRight, FlowArrow, ShieldCheck } from "@phosphor-icons/react";
import { Link, useParams } from "react-router-dom";
import { api, ApiError, json } from "../../api/client";
import type { Session, Skill, SkillDetail } from "../../api/types";
import { Empty, LoadError, PageHeader, Status } from "../../components/AppShell";

const candidateLabel: Record<string, string> = { new_skill: "新 Skill", expand_skill: "扩展 Skill", uncovered_demand: "未覆盖需求" };
const time = (value: string) => new Date(value).toLocaleString("zh-CN", { hour12: false });
const summary = (value: Record<string, unknown>) => JSON.stringify(value, null, 2);

export function SkillsPage() {
  const query = useQuery({ queryKey: ["skills"], queryFn: () => api<Skill[]>("/api/skills") });
  return <>
    <PageHeader eyebrow="L4 · Skill 聚合闭环" title="Skill 生命周期" description="查看从 L3 候选到验证、人工审核、灰度和启用的完整状态。只有通过后端门禁的 Skill 才会进入统一工具清单。" />
    {query.isError ? <LoadError error={query.error} onRetry={() => query.refetch()} /> : query.isPending ? <p className="text-sm text-[#6e6e73]">正在加载 Skill…</p> : query.data.length ? <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">{query.data.map(skill => <Link key={skill.id} to={`/skills/${skill.id}`} className="panel panel-interactive group flex min-h-[260px] flex-col p-6">
      <div className="flex items-start justify-between"><span className="grid h-11 w-11 place-items-center rounded-[12px] bg-[#eeeef0]"><FlowArrow size={21} /></span><Status value={skill.status} /></div>
      <h2 className="mt-7 break-all text-xl font-semibold">{skill.skillKey}</h2>
      <p className="mt-2 text-sm text-[#6e6e73]">{candidateLabel[skill.candidateType] ?? skill.candidateType} · 来源类别 #{skill.sourceClusterId}</p>
      <div className="mt-auto flex items-end justify-between border-t border-[#e3e3e6] pt-5"><div><p className="text-2xl font-semibold">{skill.exposurePercent}%</p><p className="text-xs text-[#6e6e73]">流量暴露</p></div><ArrowUpRight className="transition-transform group-hover:translate-x-1 group-hover:-translate-y-1" /></div>
    </Link>)}</div> : <Empty title="还没有 Skill" description="L3 候选交接并被消费后，这里会出现自动生成的草稿。" />}
  </>;
}

export function SkillDetailPage() {
  const { id } = useParams();
  const client = useQueryClient();
  const detail = useQuery({
    queryKey: ["skill", id],
    queryFn: () => api<SkillDetail>(`/api/skills/${id}`),
    refetchInterval: query => query.state.data?.validationJobs.some(job => job.status === "pending" || job.status === "running") ? 2000 : false,
  });
  const session = useQuery({ queryKey: ["session"], queryFn: () => api<Session>("/api/auth/session") });
  const [comment, setComment] = useState("");
  const action = useMutation({
    mutationFn: ({ path, body }: { path: string; body: unknown }) => api(path, json("POST", body)),
    onSuccess: () => { client.invalidateQueries({ queryKey: ["skill", id] }); client.invalidateQueries({ queryKey: ["skills"] }); },
  });
  const data = detail.data;
  if (detail.isError) return <LoadError error={detail.error} onRetry={() => detail.refetch()} />;
  if (!data) return <p className="text-sm text-[#6e6e73]">正在加载 Skill…</p>;
  const { skill, version, review, validationJobs, validationRuns } = data;
  const role = session.data?.user.role;
  const activeJob = validationJobs.find(job => job.status === "pending" || job.status === "running");
  const error = action.error instanceof ApiError ? action.error.message : null;
  const busy = action.isPending || Boolean(activeJob);

  return <>
    <PageHeader eyebrow={`L4 · 来源类别 #${skill.sourceClusterId}`} title={version?.definition.name ?? skill.skillKey} description={version?.definition.description ?? skill.statusReason ?? "Skill 生命周期记录"} />
    <section className="grid gap-4 md:grid-cols-4"><Card label="状态"><Status value={skill.status} /></Card><Card label="版本"><strong className="text-2xl">v{version?.versionNo ?? "—"}</strong></Card><Card label="灰度暴露"><strong className="text-2xl">{skill.exposurePercent}%</strong></Card><Card label="候选类型"><Status value={skill.candidateType} /></Card></section>
    <section className="mt-6 grid gap-5 lg:grid-cols-[1fr_360px]">
      <div className="space-y-5">
        <article className="panel p-6"><div className="flex items-center gap-2"><FlowArrow /><h2 className="font-semibold">固定执行步骤</h2></div><div className="mt-5 space-y-3">{version?.definition.steps.length ? version.definition.steps.map((step, index) => <div key={step.id} className="rounded-xl bg-[#f5f5f7] p-4"><p className="text-xs text-[#6e6e73]">步骤 {index + 1}</p><p className="mt-1 font-mono text-sm font-medium">{step.tool.originalName}</p><p className="mt-2 text-xs text-[#8a8a8e]">不可变 Tool 版本：{step.tool.toolVersionId ?? "尚未绑定"}</p></div>) : <p className="text-sm text-[#6e6e73]">当前版本没有执行步骤。</p>}</div></article>
        <article className="panel p-6"><div className="flex items-center gap-2"><ShieldCheck /><h2 className="font-semibold">固定验证样本</h2></div><div className="mt-5 divide-y divide-[#e3e3e6]">{version?.definition.validationCases.map(test => <div key={test.id} className="py-4 first:pt-0"><p className="text-sm font-medium">{test.query}</p><p className="mt-1 font-mono text-xs text-[#6e6e73]">{test.id}</p></div>)}</div></article>
        <article className="panel p-6"><h2 className="font-semibold">验证任务</h2>{validationJobs.length ? <div className="mt-4 divide-y divide-[#e3e3e6]">{validationJobs.map(job => <div key={job.id} className="flex flex-wrap items-center justify-between gap-3 py-4 first:pt-0"><div><p className="text-sm font-medium">{job.trigger}</p><p className="mt-1 text-xs text-[#6e6e73]">{time(job.createdAt)} · 尝试 {job.attempts} 次{job.lastError ? ` · ${job.lastError}` : ""}</p></div><Status value={job.status} /></div>)}</div> : <p className="mt-4 text-sm text-[#6e6e73]">尚未发起验证任务。</p>}</article>
        <article className="panel p-6"><h2 className="font-semibold">验证运行记录</h2>{validationRuns.length ? <div className="mt-4 space-y-4">{validationRuns.map(run => <div key={run.id} className="rounded-xl bg-[#f5f5f7] p-4"><div className="flex flex-wrap items-center justify-between gap-3"><div><p className="text-sm font-medium">{run.trigger}</p><p className="mt-1 text-xs text-[#6e6e73]">{time(run.createdAt)}</p></div><Status value={run.verdict} /></div><details className="mt-4 text-xs"><summary className="cursor-pointer text-[#6e6e73]">查看回放与数据库核对摘要</summary><div className="mt-3 grid gap-3 md:grid-cols-2"><pre className="overflow-x-auto rounded-lg bg-white p-3">{summary(run.replaySummary)}</pre><pre className="overflow-x-auto rounded-lg bg-white p-3">{summary(run.databaseCheckSummary)}</pre></div></details></div>)}</div> : <p className="mt-4 text-sm text-[#6e6e73]">尚无验证运行记录。</p>}</article>
      </div>
      <aside className="panel h-fit p-6"><p className="eyebrow">生命周期操作</p><p className="mt-3 text-sm leading-6 text-[#6e6e73]">{skill.statusReason ?? "暂无状态说明"}</p>{activeJob && <div className="mt-5 rounded-xl bg-amber-50 p-4"><Status value={activeJob.status} /><p className="mt-2 text-sm text-amber-800">验证任务正在处理，页面会自动刷新。</p></div>}{review && <div className="mt-5 rounded-xl bg-[#f5f5f7] p-4"><Status value={review.decision} /><p className="mt-2 text-sm text-[#6e6e73]">{review.comment ?? "未填写审核意见"}</p></div>}
        <div className="mt-5 space-y-2">{role === "operator" && ["draft", "validating", "paused", "degraded"].includes(skill.status) && <button disabled={busy} className="btn-secondary w-full disabled:cursor-not-allowed disabled:opacity-50" onClick={() => action.mutate({ path: `/api/skills/${skill.id}/validate`, body: { trigger: "manual" } })}>{activeJob ? "验证任务处理中" : "发起异步验证"}</button>}{role === "operator" && skill.status === "canary" && <button disabled={action.isPending} className="btn-primary w-full" onClick={() => action.mutate({ path: `/api/skills/${skill.id}/lifecycle`, body: { action: "activate" } })}>全量启用</button>}{role === "operator" && ["canary", "active"].includes(skill.status) && <button disabled={action.isPending} className="btn-secondary w-full" onClick={() => action.mutate({ path: `/api/skills/${skill.id}/lifecycle`, body: { action: "pause", reason: "控制台人工暂停" } })}>暂停运行</button>}{role === "operator" && skill.status === "paused" && <button disabled={busy} className="btn-secondary w-full" onClick={() => action.mutate({ path: `/api/skills/${skill.id}/lifecycle`, body: { action: "resume", reason: "控制台发起恢复验证" } })}>恢复并复验</button>}{role === "reviewer" && skill.status === "pending_review" && <><textarea className="field min-h-24" placeholder="审核意见" value={comment} onChange={event => setComment(event.target.value)} /><button disabled={action.isPending} className="btn-primary w-full" onClick={() => action.mutate({ path: `/api/skills/${skill.id}/review`, body: { decision: "approved", comment } })}>批准并进入灰度</button><button disabled={action.isPending} className="btn-danger w-full" onClick={() => action.mutate({ path: `/api/skills/${skill.id}/review`, body: { decision: "rejected", comment } })}>驳回 Skill</button></>}</div>{error && <p className="mt-4 text-sm text-red-600">{error}</p>}</aside>
    </section>
  </>;
}

function Card({ label, children }: { label: string; children: React.ReactNode }) { return <article className="panel p-5"><p className="eyebrow mb-4">{label}</p>{children}</article>; }
