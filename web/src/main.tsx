import React from "react";
import ReactDOM from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter } from "react-router-dom";
import { AppRouter } from "./router";
import "./styles.css";
const queryClient=new QueryClient({defaultOptions:{queries:{retry:1,staleTime:15_000},mutations:{retry:false}}});
ReactDOM.createRoot(document.getElementById("root")!).render(<React.StrictMode><QueryClientProvider client={queryClient}><BrowserRouter><AppRouter/></BrowserRouter></QueryClientProvider></React.StrictMode>);
