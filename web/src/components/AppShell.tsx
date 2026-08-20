import { ArrowUpRight, ChartLineUp, CirclesThreePlus, FlowArrow, Key, Layout, SignOut, Stack, UserCircle, Users, Wrench } from "@phosphor-icons/react";
import { NavLink, Outlet, useNavigate } from "react-router-dom";
import { api, json } from "../api/client";
import type { User } from "../api/types";

const links = [
  { to: "/", label: "工作台", icon: Layout, roles: ["member", "reviewer", "operator"] },
  { to: "/projects", label: "MCP 项目", icon: Stack, roles: ["member", "reviewer", "operator"] },
  { to: "/statistics", label: "调用与轮次", icon: ChartLineUp, roles: ["member", "reviewer", "operator"] },
  { to: "/analysis", label: "需求聚类", icon: CirclesThreePlus, roles: ["member", "reviewer", "operator"] },
  { to: "/skills", label: "Skill 闭环", icon: FlowArrow, roles: ["member", "reviewer", "operator"] },
  { to: "/reviews", label: "审核队列", icon: Wrench, roles: ["reviewer"] },
  { to: "/credentials", label: "调用凭据", icon: Key, roles: ["member", "reviewer", "operator"] },
  { to: "/users", label: "用户与角色", icon: Users, roles: ["operator"] },
];

const roleName = { member: "普通成员", reviewer: "审核员", operator: "运营管理员" };

export function AppShell({ user }: { user: User }) {
  const navigate = useNavigate();
  const logout = async () => {
    await api("/api/auth/logout", json("POST"));
    navigate("/login", { replace: true });
  };

  return <main className="min-h-screen w-full max-w-full overflow-x-hidden bg-[#f5f5f7] lg:flex">
    <aside className="border-b border-[#d2d2d7] bg-white px-4 py-3 lg:fixed lg:inset-y-0 lg:left-0 lg:z-30 lg:flex lg:w-60 lg:flex-col lg:border-b-0 lg:border-r lg:p-4">
      <NavLink to="/" className="mb-0 flex h-11 items-center gap-2.5 px-2 text-[#1d1d1f] lg:mb-5">
        <span className="grid h-8 w-8 place-items-center rounded-[9px] bg-[#1d1d1f] text-xs font-bold text-white">L</span>
        <span className="font-semibold tracking-[-.015em]">LinkCli</span>
      </NavLink>
      <nav className="flex gap-1 overflow-x-auto lg:flex-col lg:overflow-visible" aria-label="工作区导航">
        {links.filter(link => link.roles.includes(user.role)).map(({ to, label, icon: Icon }) => <NavLink key={to} to={to} end={to === "/"} className={({ isActive }) => `${isActive ? "bg-[#1d1d1f] text-white" : "text-[#48484a] hover:bg-[#eeeef0]"} flex shrink-0 items-center gap-2.5 rounded-lg px-3 py-2.5 text-sm transition active:scale-[.97]`}><Icon size={16} weight="bold" />{label}</NavLink>)}
      </nav>
      <div className="mt-auto hidden border-t border-[#d2d2d7] pt-3 lg:block">
        <NavLink to="/account" className="flex min-w-0 items-center gap-2.5 rounded-lg p-2 hover:bg-[#eeeef0]">
          <span className="grid h-7 w-7 shrink-0 place-items-center rounded-full bg-[#1d1d1f] text-white"><UserCircle size={17} weight="fill" /></span>
          <span className="min-w-0 flex-1"><span className="block truncate text-sm font-medium">{user.displayName}</span><span className="block truncate text-xs text-[#6e6e73]">{roleName[user.role]}</span></span>
        </NavLink>
        <button className="mt-1 flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-sm text-[#6e6e73] hover:bg-[#eeeef0] hover:text-[#1d1d1f]" onClick={logout}><SignOut size={15} />退出登录</button>
      </div>
    </aside>
    <div className="min-w-0 flex-1 lg:ml-60">
      <header className="sticky top-0 z-20 flex h-16 items-center justify-between border-b border-[#d2d2d7]/70 bg-[#f5f5f7]/85 px-5 backdrop-blur-xl md:px-8">
        <span className="text-sm text-[#6e6e73]">LinkCli 控制台</span>
        <div className="flex items-center gap-2 lg:hidden"><NavLink to="/account" className="text-sm font-medium">{user.displayName}</NavLink><button className="grid h-9 w-9 place-items-center rounded-full hover:bg-[#e3e3e6]" onClick={logout} aria-label="退出登录"><SignOut size={17} /></button></div>
      </header>
      <section className="mx-auto w-full max-w-[1240px] p-5 md:p-8"><Outlet /></section>
    </div>
  </main>;
}

export function PageHeader({ eyebrow, title, description, action }: { eyebrow: string; title: string; description: string; action?: React.ReactNode }) {
  return <header className="mb-8 flex flex-col justify-between gap-5 md:flex-row md:items-end"><div><p className="mb-2 text-xs text-[#6e6e73]">{eyebrow}</p><h1 className="text-[clamp(1.8rem,3vw,2.35rem)] font-semibold tracking-[-.035em] text-[#1d1d1f]">{title}</h1><p className="mt-2 max-w-2xl text-sm leading-6 text-[#6e6e73]">{description}</p></div>{action && <div className="shrink-0">{action}</div>}</header>;
}

export function Status({ value }: { value: string }) {
  const labels: Record<string, string> = { active: "运行中", healthy: "健康", unhealthy: "异常", unknown: "未知", pending: "待处理", running: "执行中", completed: "已完成", dead: "已死信", passed: "已通过", insufficient: "无法判定", cluster_error: "类别错误", pending_review: "待审核", approved: "已批准", rejected: "已驳回", disabled: "已停用", retired: "已下线", draft: "草稿", member: "成员", reviewer: "审核员", operator: "管理员", revoked: "已吊销", expired: "已过期", low: "低风险", medium: "中风险", high: "高风险", added: "新增", removed: "移除", changed: "变更", trusted:"可信", inferred:"推断", suspicious:"可疑", missing:"缺失", partial:"部分", succeeded:"已结算", failed:"失败", success:"成功", error:"错误", normal:"正常路径", uncovered:"未覆盖", observing:"观察中", handed_off:"已交接", merged:"已合并", validating:"验证中", canary:"灰度中", paused:"已暂停", degraded:"已降级", new_skill:"新 Skill", expand_skill:"扩展 Skill", uncovered_demand:"未覆盖需求" };
  return <span className={`status ${value}`}>{labels[value] ?? value.replaceAll("_", " ")}</span>;
}

export function Empty({ title, description }: { title: string; description: string }) {
  return <div className="panel grid min-h-64 place-items-center p-10 text-center"><div className="max-w-sm"><span className="mx-auto mb-5 grid h-11 w-11 place-items-center rounded-[10px] bg-[#eeeef0]"><ArrowUpRight size={18} /></span><h2 className="text-lg font-semibold">{title}</h2><p className="mt-2 text-sm leading-6 text-[#6e6e73]">{description}</p></div></div>;
}

export function LoadError({ error, onRetry }: { error: unknown; onRetry: () => void }) {
  const message = error instanceof Error ? error.message : "请求失败，请稍后重试。";
  return <div className="panel grid min-h-64 place-items-center p-10 text-center"><div className="max-w-sm"><h2 className="text-lg font-semibold">数据加载失败</h2><p className="mt-2 text-sm leading-6 text-red-600">{message}</p><button className="btn-secondary mt-5" onClick={onRetry}>重新加载</button></div></div>;
}
