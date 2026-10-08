import React from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ConfigProvider } from "antd";
import { Dashboard } from "./dashboard.tsx";
import "./styles.css";

const root = document.getElementById("root");
if (!root) throw new Error("Application root missing.");
const sessionToken = new URLSearchParams(window.location.hash.slice(1)).get("token");
if (sessionToken && /^[a-f0-9]{64}$/.test(sessionToken)) {
  window.sessionStorage.setItem("witness-agent-token", sessionToken);
  window.history.replaceState(null, "", window.location.pathname + window.location.search);
}

const queryClient = new QueryClient({ defaultOptions: { queries: { retry: 1 } } });
createRoot(root).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <ConfigProvider theme={{ token: { colorPrimary: "#3568c4", colorSuccess: "#29996B", colorInfo: "#3568c4", colorText: "#263a56", colorTextSecondary: "#74839a", colorBorder: "#e4eaf2", borderRadius: 9, controlHeight: 36, fontFamily: 'Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif' } }}>
        <Dashboard />
      </ConfigProvider>
    </QueryClientProvider>
  </React.StrictMode>,
);
