import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Copy, Key, Plus, X } from "@phosphor-icons/react";
import { api, json } from "../../api/client";
import type { Credential } from "../../api/types";
import { Empty, PageHeader, Status } from "../../components/AppShell";

export function CredentialsPage() {
  const queryClient = useQueryClient();
  const [name, setName] = useState("");
  const [token, setToken] = useState<string | null>(null);
  const query = useQuery({ queryKey: ["credentials"], queryFn: () => api<Credential[]>("/api/credentials") });
  const create = useMutation({ mutationFn: () => api<{ credential: Credential; token: string }>("/api/credentials", json("POST", { credentialName: name })), onSuccess: data => { setToken(data.token); setName(""); queryClient.invalidateQueries({ queryKey: ["credentials"] }); queueMicrotask(() => create.reset()); } });
  const revoke = useMutation({ mutationFn: (id: string) => api(`/api/credentials/${id}`, json("DELETE")), onSuccess: () => queryClient.invalidateQueries({ queryKey: ["credentials"] }) });

  return <>
    <PageHeader eyebrow="网关访问" title="调用凭据" description="供外部 Agent 连接统一 MCP 入口；完整凭据只展示一次。" />
    <form className="panel mb-5 flex flex-col gap-3 p-5 sm:flex-row" onSubmit={event => { event.preventDefault(); create.mutate(); }}><span className="grid h-11 w-11 shrink-0 place-items-center rounded-[10px] bg-[#eeeef0]"><Key size={19} /></span><input className="field flex-1" value={name} onChange={event => setName(event.target.value)} placeholder="凭据名称，例如：开发环境 Agent" required /><button className="btn-primary"><Plus size={16} />创建凭据</button></form>
    {token && <div className="mb-5 rounded-[14px] border border-[#d2d2d7] bg-[#eeeef0] p-5"><div className="flex items-start justify-between"><div><p className="text-xs text-[#6e6e73]">仅显示一次</p><h2 className="mt-1 font-semibold">立即复制并安全保存</h2></div><button onClick={() => setToken(null)} className="grid h-8 w-8 place-items-center rounded-full hover:bg-white" aria-label="关闭"><X size={16} /></button></div><div className="mt-4 flex gap-2"><code className="min-w-0 flex-1 overflow-x-auto rounded-[10px] bg-white p-3 text-sm">{token}</code><button className="btn-secondary" onClick={() => navigator.clipboard.writeText(token)} aria-label="复制凭据"><Copy size={16} /></button></div></div>}
    {query.data?.length ? <div className="panel overflow-x-auto"><table className="data-table"><thead><tr><th>名称</th><th>前缀</th><th>状态</th><th>到期时间</th><th /></tr></thead><tbody>{query.data.map(credential => <tr key={credential.id}><td className="font-medium">{credential.credentialName}</td><td className="font-mono text-sm text-[#6e6e73]">{credential.tokenPrefix}</td><td><Status value={credential.status} /></td><td className="text-sm text-[#6e6e73]">{credential.expiresAt ? new Date(credential.expiresAt).toLocaleString() : "长期有效"}</td><td>{credential.status === "active" && <button className="btn-danger" onClick={() => confirm("吊销后外部 Agent 将立即无法使用，是否继续？") && revoke.mutate(credential.id)}>吊销</button>}</td></tr>)}</tbody></table></div> : <Empty title="还没有调用凭据" description="创建后完整值只会出现一次。" />}
  </>;
}
