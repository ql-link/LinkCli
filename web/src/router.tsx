import { useQuery } from "@tanstack/react-query";
import { Navigate, Route, Routes, useLocation } from "react-router-dom";
import { api, ApiError } from "./api/client";
import type { Session } from "./api/types";
import { AppShell } from "./components/AppShell";
import { AuthPage } from "./features/auth/AuthPage";
import { DashboardPage } from "./features/dashboard/DashboardPage";
import { CredentialsPage } from "./features/credentials/CredentialsPage";
import { ProjectDetailPage, ProjectFormPage, ProjectsPage, VersionDetailPage } from "./features/projects/ProjectsPage";
import { ReviewsPage } from "./features/reviews/ReviewsPage";
import { UsersPage } from "./features/users/UsersPage";
import { AccountPage } from "./features/auth/AccountPage";

function Protected(){const location=useLocation();const query=useQuery({queryKey:["session"],queryFn:()=>api<Session>("/api/auth/session"),retry:false});if(query.isLoading)return <div className="grid min-h-screen place-items-center text-sm text-[#6e6e73]">正在建立安全会话…</div>;if(query.error instanceof ApiError&&query.error.status===401)return <Navigate to="/login" state={{from:location.pathname}} replace/>;if(!query.data)return <div className="grid min-h-screen place-items-center text-sm text-[#6e6e73]">无法加载会话</div>;return <AppShell user={query.data.user}/>}
export function AppRouter(){return <Routes><Route path="/login" element={<AuthPage mode="login"/>}/><Route path="/register" element={<AuthPage mode="register"/>}/><Route element={<Protected/>}><Route index element={<DashboardPage/>}/><Route path="projects" element={<ProjectsPage/>}/><Route path="projects/new" element={<ProjectFormPage/>}/><Route path="projects/:projectKey" element={<ProjectDetailPage/>}/><Route path="projects/:projectKey/versions/new" element={<ProjectFormPage version/>}/><Route path="versions/:versionId" element={<VersionDetailPage/>}/><Route path="reviews" element={<ReviewsPage/>}/><Route path="credentials" element={<CredentialsPage/>}/><Route path="users" element={<UsersPage/>}/><Route path="account" element={<AccountPage/>}/></Route><Route path="*" element={<Navigate to="/" replace/>}/></Routes>}
