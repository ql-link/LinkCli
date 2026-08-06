import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowRight, ArrowUpRight, Globe, MagnifyingGlass, Plus, ShieldCheck, Wrench } from "@phosphor-icons/react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { api, ApiError, json } from "../../api/client";
import type { Project, Version } from "../../api/types";
import { Empty, PageHeader, Status } from "../../components/AppShell";

export function ProjectsPage() {
  const [queryText, setQueryText] = useState("");
  const query = useQuery({ queryKey: ["projects", queryText], queryFn: () => api<Project[]>(`/api/projects?query=${encodeURIComponent(queryText)}`) });
  return <>
    <PageHeader eyebrow="项目登记中心" title="MCP 项目" description="集中查看每个项目的发布、健康与工具发现状态。" action={<Link className="btn-primary gap-2" to="/projects/new"><Plus size={17} weight="bold" />登记项目</Link>} />
    <div className="relative mb-6 max-w-md">
      <MagnifyingGlass className="absolute left-4 top-1/2 -translate-y-1/2 text-[#8a8a8e]" size={18} />
      <input className="field pl-11" placeholder="搜索项目名称或标识" value={queryText} onChange={event => setQueryText(event.target.value)} />
    </div>
    {query.data?.length ? <div className="grid grid-flow-dense gap-3 md:grid-cols-2 xl:grid-cols-3">
      {query.data.map(project => <Link key={project.id} to={`/projects/${project.projectKey}`} className="panel panel-interactive group flex min-h-[250px] flex-col justify-between overflow-hidden p-6">
        <div>
          <div className="flex items-start justify-between gap-4">
            <span className="grid h-11 w-11 place-items-center rounded-[13px] bg-[#eeeef0] text-[#1d1d1f]"><Globe size={21} weight="bold" /></span>
            <div className="flex flex-wrap justify-end gap-2"><Status value={project.status} /><Status value={project.healthStatus} /></div>
          </div>
          <h2 className="mt-8 text-2xl font-semibold tracking-[-.04em]">{project.displayName}</h2>
          <p className="mt-2 font-mono text-xs text-[#8a8a8e]">{project.projectKey}</p>
        </div>
        <div className="mt-10 flex items-end justify-between border-t border-[#e3e3e6] pt-5">
          <div><p className="text-3xl font-semibold tracking-[-.05em]">{project.toolCount}</p><p className="mt-1 text-xs text-[#6e6e73]">已发现工具</p></div>
          <ArrowUpRight className="text-[#1d1d1f] transition-transform duration-500 group-hover:translate-x-1 group-hover:-translate-y-1" size={21} weight="bold" />
        </div>
      </Link>)}
    </div> : <Empty title="还没有可见项目" description="登记第一个标准 MCP 服务，平台会自动发现工具。" />}
  </>;
}

export function ProjectFormPage({ version = false }: { version?: boolean }) {
  const { projectKey } = useParams();
  const navigate = useNavigate();
  const [form, setForm] = useState({ projectKey: "", displayName: "", description: "", endpoint: "", projectToken: "" });
  const mutation = useMutation({
    mutationFn: () => api<{ project?: Project; version: Version }>(version ? `/api/projects/${projectKey}/versions` : "/api/projects", json("POST", version ? { endpoint: form.endpoint, ...(form.projectToken ? { projectToken: form.projectToken } : {}) } : { projectKey: form.projectKey, displayName: form.displayName, description: form.description, endpoint: form.endpoint, ...(form.projectToken ? { projectToken: form.projectToken } : {}) })),
    onSuccess: data => {
      setForm({ ...form, projectToken: "" });
      navigate(version ? `/versions/${data.version.id}` : `/projects/${data.project?.projectKey ?? form.projectKey}`, { replace: true });
    },
    onError: () => setForm(current => ({ ...current, projectToken: "" })),
  });
  const error = mutation.error instanceof ApiError ? mutation.error.message : null;

  return <>
    <PageHeader eyebrow={version ? "候选版本" : "服务接入"} title={version ? "创建新版本" : "登记 MCP 项目"} description="连接标准 Streamable HTTP 服务并发现工具；项目 Token 提交后立即清除。" />
    <div className="grid gap-5 lg:grid-cols-[1fr_320px]">
      <form className="panel space-y-5 p-6 md:p-8" onSubmit={event => { event.preventDefault(); mutation.mutate(); }}>
        {!version && <div className="grid gap-5 md:grid-cols-2">
          <label className="block text-sm font-medium text-[#48484a]">稳定项目标识<input className="field mt-2" pattern="[A-Za-z0-9][A-Za-z0-9_-]{1,47}" value={form.projectKey} onChange={event => setForm({ ...form, projectKey: event.target.value })} required /></label>
          <label className="block text-sm font-medium text-[#48484a]">展示名称<input className="field mt-2" value={form.displayName} onChange={event => setForm({ ...form, displayName: event.target.value })} required /></label>
          <label className="block text-sm font-medium text-[#48484a] md:col-span-2">项目说明<textarea className="field mt-2 min-h-28 resize-y" value={form.description} onChange={event => setForm({ ...form, description: event.target.value })} required /></label>
        </div>}
        <label className="block text-sm font-medium text-[#48484a]">标准 MCP 地址<input type="url" className="field mt-2" placeholder="https://mcp.example.com/mcp" value={form.endpoint} onChange={event => setForm({ ...form, endpoint: event.target.value })} required /></label>
        <label className="block text-sm font-medium text-[#48484a]">项目 Token（可选）<input type="password" autoComplete="off" className="field mt-2" value={form.projectToken} onChange={event => setForm({ ...form, projectToken: event.target.value })} /><span className="mt-2 block text-xs font-normal text-[#8a8a8e]">只用于连接目标项目，不会在页面、接口或日志中回显。</span></label>
        {error && <p className="rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-700">{error}</p>}
        <button disabled={mutation.isPending} className="btn-primary gap-2 disabled:opacity-50">{mutation.isPending ? "正在发现工具" : version ? "创建候选版本" : "登记并发现"}<ArrowRight size={17} weight="bold" /></button>
      </form>
      <aside className="panel p-6 lg:h-fit">
        <ShieldCheck size={24} weight="fill" />
        <h2 className="mt-8 text-xl font-semibold tracking-[-.03em]">接入边界</h2>
        <ul className="mt-4 space-y-3 text-sm leading-6 text-[#6e6e73]"><li>仅标准 Streamable HTTP</li><li>项目权限仍由下游自行判断</li><li>工具发现成功后再进入审核流程</li></ul>
      </aside>
    </div>
  </>;
}

export function ProjectDetailPage() {
  const { projectKey } = useParams();
  const queryClient = useQueryClient();
  const query = useQuery({ queryKey: ["project", projectKey], queryFn: () => api<Project>(`/api/projects/${projectKey}`) });
  const mutate = useMutation({ mutationFn: ({ path, body }: { path: string; body: unknown }) => api(path, json("PATCH", body)), onSuccess: () => queryClient.invalidateQueries({ queryKey: ["project", projectKey] }) });
  const submit = useMutation({ mutationFn: (id: string) => api(`/api/versions/${id}/submit`, json("POST")), onSuccess: () => queryClient.invalidateQueries({ queryKey: ["project", projectKey] }) });
  const project = query.data;
  if (!project) return <div className="text-sm text-[#6e6e73]">正在加载项目…</div>;
  const latest = project.versions?.[0];

  return <>
    <PageHeader eyebrow={project.projectKey} title={project.displayName} description={project.description} action={project.allowedActions?.includes("create_version") ? <Link className="btn-primary" to={`/projects/${project.projectKey}/versions/new`}>创建新版本</Link> : undefined} />
    <div className="grid grid-flow-dense gap-4 lg:grid-cols-12">
      <section className="panel p-6 lg:col-span-8">
        <div className="grid gap-7 sm:grid-cols-3"><Metric label="项目状态"><Status value={project.status} /></Metric><Metric label="健康状态"><Status value={project.healthStatus} /></Metric><Metric label="生效版本"><span className="text-3xl font-semibold tracking-[-.04em]">{project.activeVersionNo ? `v${project.activeVersionNo}` : "—"}</span></Metric></div>
        <div className="mt-9 flex flex-wrap gap-3 border-t border-[#e3e3e6] pt-6">
          {project.allowedActions?.includes("submit_version") && latest && <button className="btn-primary" onClick={() => submit.mutate(latest.id)}>提交 v{latest.versionNo} 审核</button>}
          {project.allowedActions?.includes("disable_project") && <button className="btn-secondary" onClick={() => confirm("停用后工具会从统一清单移除，是否继续？") && mutate.mutate({ path: `/api/projects/${project.projectKey}/status`, body: { action: "disable" } })}>停用项目</button>}
          {project.allowedActions?.includes("enable_project") && <button className="btn-secondary" onClick={() => mutate.mutate({ path: `/api/projects/${project.projectKey}/status`, body: { action: "enable" } })}>恢复项目</button>}
          {project.allowedActions?.includes("retire_project") && <button className="btn-danger" onClick={() => confirm("永久下线后不可恢复，是否继续？") && mutate.mutate({ path: `/api/projects/${project.projectKey}/status`, body: { action: "retire" } })}>永久下线</button>}
        </div>
      </section>
      <aside className="rounded-[14px] bg-[#eeeef0] p-6 lg:col-span-4">
        <Wrench size={22} className="text-[#1d1d1f]" weight="fill" /><h2 className="mt-7 text-xl font-semibold tracking-[-.03em]">可信项目免审</h2><p className="mt-3 text-sm leading-6 text-[#48484a]">{project.trustedReviewBypassEnabled ? "已开启；提交后仍须探活成功。" : "默认关闭；版本将进入人工审核。"}</p>
        {project.allowedActions?.includes("set_trusted_review_bypass") && <button className="btn-secondary mt-5" onClick={() => mutate.mutate({ path: `/api/projects/${project.projectKey}/trusted-review-bypass`, body: { enabled: !project.trustedReviewBypassEnabled } })}>{project.trustedReviewBypassEnabled ? "关闭免审" : "开启免审"}</button>}
      </aside>
      <section className="panel overflow-hidden lg:col-span-12">
        <div className="flex items-center justify-between border-b border-[#e3e3e6] p-6"><div><p className="eyebrow">版本轨迹</p><h2 className="mt-2 text-xl font-semibold">版本历史</h2></div><span className="text-sm text-[#6e6e73]">{project.versions?.length ?? 0} 个版本</span></div>
        <div className="divide-y divide-[#e3e3e6]">{project.versions?.map(version => <Link key={version.id} to={`/versions/${version.id}`} className="group flex items-center justify-between gap-4 p-5 transition hover:bg-[#fbfbfc]"><div><p className="font-semibold">版本 v{version.versionNo}</p><p className="mt-1 break-all text-sm text-[#6e6e73]">{version.endpoint}</p></div><div className="flex items-center gap-2"><Status value={version.riskLevel} /><Status value={version.reviewStatus} /><ArrowUpRight className="ml-2 text-[#1d1d1f]" /></div></Link>)}</div>
      </section>
      <section className="panel overflow-x-auto lg:col-span-12"><table className="data-table"><thead><tr><th>工具</th><th>风险</th><th>运行状态</th><th>说明</th></tr></thead><tbody>{project.tools?.map(tool => <tr key={tool.id}><td className="font-mono text-sm font-medium">{tool.publicName}</td><td><Status value={tool.riskLevel} /></td><td><Status value={tool.runtimeStatus} /></td><td className="max-w-xl text-sm text-[#6e6e73]">{tool.description}</td></tr>)}</tbody></table></section>
    </div>
  </>;
}

export function VersionDetailPage() {
  const { versionId } = useParams();
  const queryClient = useQueryClient();
  const query = useQuery({ queryKey: ["version", versionId], queryFn: () => api<Version>(`/api/versions/${versionId}`) });
  const [comment, setComment] = useState("");
  const action = useMutation({ mutationFn: ({ path, body }: { path: string; body?: unknown }) => api(path, json("POST", body)), onSuccess: () => { queryClient.invalidateQueries({ queryKey: ["version", versionId] }); queryClient.invalidateQueries({ queryKey: ["reviews"] }); } });
  const version = query.data;
  if (!version) return <div className="text-sm text-[#6e6e73]">正在加载版本…</div>;
  return <>
    <PageHeader eyebrow={`版本 ${version.versionNo}`} title={version.project?.displayName ?? "候选版本"} description={version.endpoint} />
    <div className="grid gap-4 lg:grid-cols-[1fr_380px]">
      <section className="panel p-6 md:p-8"><div className="flex flex-wrap gap-2"><Status value={version.reviewStatus} /><Status value={version.riskLevel} /></div><h2 className="mt-9 text-2xl font-semibold tracking-[-.035em]">工具差异</h2><div className="mt-5 divide-y divide-[#e3e3e6]">{version.diff?.map(diff => <div key={diff.name} className="flex items-center justify-between py-4"><span className="font-mono text-sm">{diff.name}</span><Status value={diff.change} /></div>)}</div></section>
      <aside className="panel h-fit p-6"><p className="eyebrow">审核决策</p>{version.review ? <div className="mt-5"><Status value={version.review.decision} /><p className="mt-5 text-sm leading-6 text-[#6e6e73]">{version.review.comment ?? "未填写审核意见"}</p></div> : <><p className="mt-4 text-sm leading-6 text-[#6e6e73]">根据工具定义差异与风险作出决策。批准后仍需探活成功才会发布。</p>{version.allowedActions?.includes("submit_version") && <button className="btn-primary mt-6 w-full" onClick={() => action.mutate({ path: `/api/versions/${version.id}/submit` })}>提交审核</button>}{version.allowedActions?.includes("review_version") && <div className="mt-6 space-y-3"><textarea className="field min-h-28" placeholder="驳回时必须填写原因" value={comment} onChange={event => setComment(event.target.value)} /><button className="btn-primary w-full" onClick={() => action.mutate({ path: `/api/versions/${version.id}/review`, body: { decision: "approved", comment } })}>批准版本</button><button className="btn-danger w-full" onClick={() => action.mutate({ path: `/api/versions/${version.id}/review`, body: { decision: "rejected", comment } })}>驳回版本</button></div>}</>}</aside>
    </div>
  </>;
}

function Metric({ label, children }: { label: string; children: React.ReactNode }) {
  return <div><p className="eyebrow mb-3">{label}</p>{children}</div>;
}
