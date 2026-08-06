import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { MagnifyingGlass } from "@phosphor-icons/react";
import { api, json } from "../../api/client";
import type { Role, User } from "../../api/types";
import { Empty, PageHeader, Status } from "../../components/AppShell";

export function UsersPage() {
  const queryClient = useQueryClient();
  const [queryText, setQueryText] = useState("");
  const query = useQuery({ queryKey: ["users", queryText], queryFn: () => api<User[]>(`/api/users?query=${encodeURIComponent(queryText)}`) });
  const mutation = useMutation({ mutationFn: ({ id, role }: { id: string; role: Role }) => api(`/api/users/${id}/role`, json("PATCH", { role })), onSuccess: () => queryClient.invalidateQueries({ queryKey: ["users"] }) });
  return <>
    <PageHeader eyebrow="身份管理" title="用户与角色" description="注册只创建普通成员，高权限必须由运营管理员显式授予。" />
    <div className="relative mb-6 max-w-md"><MagnifyingGlass className="absolute left-4 top-1/2 -translate-y-1/2 text-[#8a8a8e]" size={18} /><input className="field pl-11" placeholder="搜索用户名或显示名称" value={queryText} onChange={event => setQueryText(event.target.value)} /></div>
    {query.data?.length ? <div className="panel overflow-x-auto"><table className="data-table"><thead><tr><th>用户</th><th>当前角色</th><th>调整角色</th><th>创建时间</th></tr></thead><tbody>{query.data.map(user => <tr key={user.id}><td><p className="font-semibold">{user.displayName}</p><p className="mt-1 font-mono text-xs text-[#8a8a8e]">{user.username}</p></td><td><Status value={user.role} /></td><td><select className="field max-w-44" value={user.role} onChange={event => confirm(`确认将 ${user.displayName} 调整为 ${event.target.value}？`) && mutation.mutate({ id: user.id, role: event.target.value as Role })}><option value="member">普通成员</option><option value="reviewer">审核员</option><option value="operator">运营管理员</option></select></td><td className="text-sm text-[#6e6e73]">{new Date(user.createdAt).toLocaleDateString()}</td></tr>)}</tbody></table></div> : <Empty title="没有匹配用户" description="调整搜索条件后重试。" />}
  </>;
}
