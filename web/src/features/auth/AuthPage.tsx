import { useRef, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "react-router-dom";
import { useGSAP } from "@gsap/react";
import gsap from "gsap";
import { ArrowRight, CirclesFour, LockKey, Pulse } from "@phosphor-icons/react";
import { api, ApiError, json } from "../../api/client";
import type { Session, User } from "../../api/types";

export function AuthPage({ mode }: { mode: "login" | "register" }) {
  const root = useRef<HTMLDivElement>(null);
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [form, setForm] = useState({ username: "", displayName: "", password: "" });

  useGSAP(() => {
    gsap.from(".auth-enter", { y: 18, opacity: 0, duration: .6, stagger: .07, ease: "power3.out" });
    gsap.from(".auth-story-card", { x: 24, opacity: 0, duration: .75, ease: "power3.out", delay: .12 });
  }, { scope: root });

  const mutation = useMutation({
    mutationFn: async () => mode === "login" ? api<Session>("/api/auth/login", json("POST", { username: form.username, password: form.password })) : api<{ user: User }>("/api/auth/register", json("POST", form)),
    onSuccess: async data => {
      if (mode === "login") {
        queryClient.setQueryData(["session"], data);
        navigate("/", { replace: true });
      } else navigate("/login", { replace: true });
    },
  });
  const error = mutation.error instanceof ApiError ? mutation.error.message : null;

  return <main ref={root} className="grid min-h-screen w-full max-w-full overflow-x-hidden bg-white lg:grid-cols-[52%_48%]">
    <section className="flex min-h-screen items-center justify-center px-6 py-12 md:px-12">
      <div className="w-full max-w-[420px]">
        <Link to="/" className="auth-enter mb-16 flex items-center gap-2.5 text-[#1d1d1f]"><span className="grid h-8 w-8 place-items-center rounded-[9px] bg-[#1d1d1f] text-xs font-bold text-white">L</span><span className="font-semibold">LinkCli</span></Link>
        <div className="auth-enter"><p className="text-xs font-medium uppercase tracking-[.12em] text-[#6e6e73]">Enterprise MCP Gateway</p><h1 className="mt-4 text-[clamp(2.5rem,5vw,4.5rem)] font-semibold leading-[.96] tracking-[-.055em]">{mode === "login" ? "欢迎回来。" : "创建账户。"}</h1><p className="mt-4 text-[15px] leading-6 text-[#6e6e73]">统一管理企业内部 MCP 项目的登记、审核与调用。</p></div>
        <form className="auth-enter mt-9 space-y-5" onSubmit={event => { event.preventDefault(); mutation.mutate(); }}>
          <label className="block text-sm font-medium">用户名<input autoComplete="username" className="field mt-2" value={form.username} onChange={event => setForm({ ...form, username: event.target.value })} required /></label>
          {mode === "register" && <label className="block text-sm font-medium">显示名称<input className="field mt-2" value={form.displayName} onChange={event => setForm({ ...form, displayName: event.target.value })} required /></label>}
          <label className="block text-sm font-medium">密码<input autoComplete={mode === "login" ? "current-password" : "new-password"} type="password" minLength={12} className="field mt-2" value={form.password} onChange={event => setForm({ ...form, password: event.target.value })} required /></label>
          {error && <p className="rounded-[10px] border border-red-300/50 bg-red-50 p-3 text-sm text-red-700">{error}</p>}
          <button disabled={mutation.isPending} className="btn-primary w-full justify-between disabled:opacity-50"><span>{mutation.isPending ? "处理中…" : mode === "login" ? "登录" : "注册普通成员"}</span><ArrowRight size={16} /></button>
        </form>
        <Link className="auth-enter mt-5 inline-flex items-center gap-2 rounded-lg px-2 py-2 text-sm text-[#48484a] hover:bg-[#eeeef0]" to={mode === "login" ? "/register" : "/login"}>{mode === "login" ? "没有账号？创建一个" : "已有账号？返回登录"}<ArrowRight size={14} /></Link>
      </div>
    </section>
    <aside className="auth-story-card relative hidden min-h-screen overflow-hidden bg-[#eeeef0] p-12 lg:flex lg:items-center lg:justify-center">
      <div className="absolute inset-0 opacity-50 [background-image:linear-gradient(#d2d2d7_1px,transparent_1px),linear-gradient(90deg,#d2d2d7_1px,transparent_1px)] [background-size:48px_48px]" />
      <div className="relative w-full max-w-[520px] rounded-[20px] border border-[#d2d2d7] bg-white/88 p-9 shadow-[0_24px_60px_rgba(0,0,0,.10)] backdrop-blur-xl">
        <div className="flex items-center justify-between"><span className="text-xs font-medium text-[#6e6e73]">统一接入流程</span><LockKey size={18} /></div>
        <blockquote className="mt-16 text-[clamp(1.9rem,3vw,3rem)] font-medium leading-[1.12] tracking-[-.04em]">“一个清晰入口，连接企业内部所有标准 MCP 服务。”</blockquote>
        <div className="mt-14 grid grid-cols-2 gap-3"><div className="rounded-[14px] bg-[#f5f5f7] p-5"><CirclesFour size={20} /><p className="mt-8 text-sm font-medium">登记与审核</p></div><div className="rounded-[14px] bg-[#1d1d1f] p-5 text-white"><Pulse size={20} /><p className="mt-8 text-sm font-medium">探活与路由</p></div></div>
      </div>
    </aside>
  </main>;
}
