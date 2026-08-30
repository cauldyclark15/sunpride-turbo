import {
  ConvexBetterAuthProvider,
  type AuthClient,
} from "@convex-dev/better-auth/react";
import { ConvexReactClient } from "convex/react";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router";
import { registerSW } from "virtual:pwa-register";
import App from "./App";
import { authClient } from "./lib/auth-client";
import "./index.css";

const convex = new ConvexReactClient(import.meta.env.VITE_CONVEX_URL, {
  expectAuth: true,
});
registerSW({ immediate: true });
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ConvexBetterAuthProvider
      client={convex}
      authClient={authClient as unknown as AuthClient}
    >
      <BrowserRouter>
        <App />
      </BrowserRouter>
    </ConvexBetterAuthProvider>
  </StrictMode>,
);
