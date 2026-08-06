import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { UserCircle } from "@phosphor-icons/react";
import { api, json } from "../../api/client";
import type { Session } from "../../api/types";
import { PageHeader, Status } from "../../components/AppShell";

export function AccountPage() {
  const queryClient = useQueryClient();
  const session = useQuery({ queryKey: ["session"], queryFn: () => api<Session>("/api/auth/session") });
  const [name, setName] = useState("");
  const mutation = useMutation({ mutationFn: () => api("/api/me", json("PATCH", { displayName: name })), onSuccess: () => queryClient.invalidateQueries({ queryKey: ["session"] }) });
  const user = session.data?.user;
  return <>
    <PageHeader eyebrow="个人设置" title="个人账户" description="查看当前身份并维护控制台中的展示名称。" />
    <div className="grid max-w-4xl gap-5 md:grid-cols-[280px_1fr]">
      <aside className="rounded-[14px] bg-[#eeeef0] p-6"><span className="grid h-14 w-14 place-items-center rounded-full bg-white/70 text-[#1d1d1f]"><UserCircle size={30} weight="fill" /></span><h2 className="mt-8 text-2xl font-semibold tracking-[-.035em]">{user?.displayName}</h2><p className="mt-2 font-mono text-sm text-[#6e6e73]">@{user?.username}</p><div className="mt-5"><Status value={user?.role ?? "member"} /></div></aside>
      <section className="panel p-6 md:p-8"><dl className="grid gap-6 md:grid-cols-2"><div><dt className="eyebrow">用户名</dt><dd className="mt-2 font-medium">{user?.username}</dd></div><div><dt className="eyebrow">角色</dt><dd className="mt-2 font-medium">{user?.role}</dd></div><div className="md:col-span-2"><dt className="eyebrow">会话到期</dt><dd className="mt-2 font-medium">{session.data?.session.expiresAt ? new Date(session.data.session.expiresAt).toLocaleString() : "—"}</dd></div></dl><form className="mt-8 border-t border-[#e3e3e6] pt-7" onSubmit={event => { event.preventDefault(); mutation.mutate(); }}><label className="block text-sm font-medium text-[#48484a]">新的显示名称<input className="field mt-2" value={name} onChange={event => setName(event.target.value)} placeholder={user?.displayName} /></label><button className="btn-primary mt-4">保存资料</button></form></section>
    </div>
  </>;
}
