import React from "react";
import ReactDOM from "react-dom/client";
import { createBrowserRouter, RouterProvider } from "react-router-dom";
import { WagmiProvider } from "wagmi";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RainbowKitProvider, darkTheme, lightTheme } from "@rainbow-me/rainbowkit";
import "@rainbow-me/rainbowkit/styles.css";
import "./styles/global.css";
import { wagmiConfig, defaultChainId } from "./config/wagmi";
import { ToastProvider } from "./components/Toasts";
import { Layout } from "./components/Layout";
import { Home } from "./pages/Home";
import { MachinePage } from "./pages/Machine";
import { Sell } from "./pages/Sell";
import { Bids } from "./pages/Bids";
import { Pool } from "./pages/Pool";
import { OddsPage } from "./pages/Odds";
import { Vault } from "./pages/Vault";
import { Create } from "./pages/Create";

document.documentElement.dataset.theme = localStorage.getItem("theme") || "dark";

const queryClient = new QueryClient({ defaultOptions: { queries: { refetchOnWindowFocus: false } } });

const router = createBrowserRouter([
  {
    element: <Layout />,
    children: [
      { path: "/", element: <Home /> },
      { path: "/machine/:address", element: <MachinePage /> },
      { path: "/sell", element: <Sell /> },
      { path: "/bids", element: <Bids /> },
      { path: "/pool", element: <Pool /> },
      { path: "/odds", element: <OddsPage /> },
      { path: "/vault", element: <Vault /> },
      { path: "/create", element: <Create /> },
    ],
  },
]);

const accent = "#FC72FF";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <WagmiProvider config={wagmiConfig}>
      <QueryClientProvider client={queryClient}>
        <RainbowKitProvider
          initialChain={defaultChainId}
          locale="zh-CN"
          modalSize="compact"
          theme={{
            lightMode: lightTheme({ accentColor: "#FF37C7", borderRadius: "large" }),
            darkMode: darkTheme({ accentColor: accent, borderRadius: "large" }),
          }}
        >
          <ToastProvider>
            <RouterProvider router={router} />
          </ToastProvider>
        </RainbowKitProvider>
      </QueryClientProvider>
    </WagmiProvider>
  </React.StrictMode>,
);
